/**
 * occ-kernel.js
 *
 * OpenCASCADE.js solid-modeling kernel wrapper (路线B 完整三维实体建模).
 *
 * This module wraps the OpenCASCADE.js WASM build (`opencascade.js` v1.1.1) behind a
 * small, allocator-safe solid kernel.  Body ids are monotonic integers; the underlying
 * `TopoDS_Shape` objects are kept in an internal Map and are freed with `.delete()`.
 *
 * API surface (see Kernel class below):
 *   createBox / createCylinder / createSphere / createCone / createTorus
 *   boolean / transform / copy / mesh / volume / bbox
 *   exportSTL / exportSTEP / importSTEP
 *   fillet / chamfer
 *   deleteBody / bodyCount / dispose
 *
 * Verified call signatures for opencascade.js v1.1.1 (Node + browser):
 *   - Primitives:       new oc.BRepPrimAPI_MakeBox_1(dx,dy,dz)
 *                       new oc.BRepPrimAPI_MakeCylinder_1(r,h)
 *                       new oc.BRepPrimAPI_MakeSphere_1(r)
 *                       new oc.BRepPrimAPI_MakeCone_1(r1,r2,h)
 *                       new oc.BRepPrimAPI_MakeTorus_1(r1,r2)
 *   - Boolean:          new oc.BRepAlgoAPI_Cut_3(a,b)     (also Fuse_3 / Common_3)
 *   - Volume:           oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false)
 *   - Bbox:             oc.BRepBndLib.Add(shape, box, true)
 *   - Mesh:             new oc.BRepMesh_IncrementalMesh_2(shape, lin, false, ang, false)
 *   - Transform:        new oc.BRepBuilderAPI_Transform_2(shape, trsf, copy)
 *   - Fillet/Chamfer:   Add_2(radius|distance, edge)
 *   - STEP:             writer.Transfer(shape, STEPControl_StepModelType.STEPControl_AsIs, true)
 *
 * Implementation notes (observed on this build):
 *   - StlAPI_Writer.Write() returns false (default tessellation deflection is too
 *     small and SetDeflection is not bound), so exportSTL emits a binary STL directly
 *     from the mesh() triangles instead.
 *   - OCC's STEP reader/writer only accepts filenames of up to 5 characters before
 *     the extension in this WASM build; longer names yield IFSelect_RetError.  The
 *     export/import methods therefore use the short names `out.step` / `in.step`.
 */

let ocInstance = null;
let ocLoadingPromise = null;

function isNodeEnv() {
  return typeof process !== 'undefined' && process.versions && process.versions.node;
}

/**
 * Load (once) and return the OpenCASCADE.js module object.
 * @param {{locateFile?:Function, wasmBinary?:Uint8Array, glueUrl?:string}} opts
 * @returns {Promise<object>} the `oc` module object
 */
async function loadOpenCascade(opts = {}) {
  if (ocLoadingPromise) return ocLoadingPromise;
  ocLoadingPromise = (async () => {
    const initOpts = {
      // emscripten prints the glue source to stderr in Node; silence both streams.
      print: () => {},
      printErr: () => {},
    };

    let factory;
    if (isNodeEnv()) {
      // The emscripten glue references `__dirname` when `__filename` is unavailable (ESM).
      globalThis.__dirname = process.cwd();
      const path = (await import('node:path')).default;
      const fs = (await import('node:fs')).default;
      const dir = path.join(process.cwd(), 'node_modules', 'opencascade.js', 'dist') + path.sep;
      initOpts.locateFile = opts.locateFile || ((f) => path.join(dir, f));
      if (opts.wasmBinary) {
        initOpts.wasmBinary = opts.wasmBinary;
      } else {
        // Passing wasmBinary avoids Node's global fetch being used against a plain
        // filesystem path (which fails with "Failed to parse URL").
        initOpts.wasmBinary = fs.readFileSync(path.join(dir, 'opencascade.wasm.wasm'));
      }
      const glueUrl = opts.glueUrl || path.join(dir, 'opencascade.wasm.js');
      factory = (await import(glueUrl)).default;
    } else {
      initOpts.locateFile = opts.locateFile || ((f) => '/node_modules/opencascade.js/dist/' + f);
      if (opts.wasmBinary) initOpts.wasmBinary = opts.wasmBinary;
      const glueUrl = opts.glueUrl || '/node_modules/opencascade.js/dist/opencascade.wasm.js';
      factory = (await import(glueUrl)).default;
    }

    ocInstance = await factory(initOpts);
    return ocInstance;
  })();
  return ocLoadingPromise;
}

/**
 * Initialize the kernel. Returns a Promise resolving to a new Kernel instance.
 * @param {object} opts
 * @param {Function} [opts.locateFile]  optional emscripten file locator (browser/Node)
 * @param {Uint8Array} [opts.wasmBinary] optional raw wasm bytes
 * @param {string} [opts.glueUrl]       optional glue module URL/path
 * @returns {Promise<Kernel>}
 */
export async function initKernel(opts = {}) {
  const oc = await loadOpenCascade(opts);
  return new Kernel(oc);
}

export class Kernel {
  constructor(oc) {
    this.oc = oc;
    this._nextId = 1;
    /** @type {Map<number, object>} id -> TopoDS_Shape */
    this._bodies = new Map();
    this._disposed = false;
  }

  /* ------------------------------------------------------------------ util -- */

  _assertReady() {
    if (this._disposed || !this.oc) {
      throw new Error('内核未初始化或已释放');
    }
  }

  _assertBody(id) {
    const shape = this._bodies.get(id);
    if (!shape) throw new Error(`未知 bodyId: ${id}`);
    return shape;
  }

  _store(shape) {
    const id = this._nextId++;
    this._bodies.set(id, shape);
    return id;
  }

  _volume(shape) {
    const props = new this.oc.GProp_GProps_1();
    this.oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    const v = props.Mass();
    props.delete();
    return v;
  }

  _bbox(shape) {
    const box = new this.oc.Bnd_Box_1();
    this.oc.BRepBndLib.Add(shape, box, true);
    const r = {
      minX: box.GetXmin(), maxX: box.GetXmax(),
      minY: box.GetYmin(), maxY: box.GetYmax(),
      minZ: box.GetZmin(), maxZ: box.GetZmax(),
    };
    box.delete();
    return r;
  }

  _translate(x, y, z) {
    const tr = new this.oc.gp_Trsf_1();
    const v = new this.oc.gp_Vec_4(x, y, z);
    tr.SetTranslation_1(v);
    v.delete();
    return tr;
  }

  _rotate(axis, rad) {
    const tr = new this.oc.gp_Trsf_1();
    const pnt = new this.oc.gp_Pnt_3(0, 0, 0);
    const dir = new this.oc.gp_Dir_4(axis[0], axis[1], axis[2]);
    const ax = new this.oc.gp_Ax1_2(pnt, dir);
    tr.SetRotation_1(ax, rad);
    ax.delete();
    dir.delete();
    pnt.delete();
    return tr;
  }

  _scale(factor) {
    const tr = new this.oc.gp_Trsf_1();
    const pnt = new this.oc.gp_Pnt_3(0, 0, 0);
    tr.SetScale(pnt, factor);
    pnt.delete();
    return tr;
  }

  _transformShape(shape, t) {
    const dx = t.dx || 0, dy = t.dy || 0, dz = t.dz || 0;
    const rx = t.rx || 0, ry = t.ry || 0, rz = t.rz || 0;
    const scale = t.scale === undefined ? 1 : t.scale;
    const rad = (deg) => deg * Math.PI / 180;

    const bb = this._bbox(shape);
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = (bb.minY + bb.maxY) / 2;
    const cz = (bb.minZ + bb.maxZ) / 2;

    // Composite transform (applied to a point right-to-left):
    //   translate(-center) -> scale -> rotateX -> rotateY -> rotateZ -> translate(center + d)
    // In gp_Trsf terms:  T_final * Rz * Ry * Rx * S * T_negC
    let acc = this._translate(-cx, -cy, -cz);
    const steps = [];
    if (scale !== 1) steps.push(this._scale(scale));
    if (rx) steps.push(this._rotate([1, 0, 0], rad(rx)));
    if (ry) steps.push(this._rotate([0, 1, 0], rad(ry)));
    if (rz) steps.push(this._rotate([0, 0, 1], rad(rz)));
    steps.push(this._translate(cx + dx, cy + dy, cz + dz));

    for (const step of steps) {
      // step.Multiplied(acc) === step * acc  (acc is applied first)
      const next = step.Multiplied(acc);
      step.delete();
      acc.delete();
      acc = next;
    }

    const builder = new this.oc.BRepBuilderAPI_Transform_2(shape, acc, true);
    const newShape = builder.Shape();
    builder.delete();
    acc.delete();
    return newShape;
  }

  /* ------------------------------------------------------------- creation -- */

  createBox(p = {}) {
    this._assertReady();
    const x = p.x || 0, y = p.y || 0, z = p.z || 0;
    const dx = p.dx === undefined ? 10 : p.dx;
    const dy = p.dy === undefined ? 10 : p.dy;
    const dz = p.dz === undefined ? 10 : p.dz;
    const maker = new this.oc.BRepPrimAPI_MakeBox_1(dx, dy, dz);
    let shape = maker.Shape();
    maker.delete();
    // center the box on (x, y, z)
    shape = this._transformShape(shape, { dx: x - dx / 2, dy: y - dy / 2, dz: z - dz / 2 });
    return this._store(shape);
  }

  createCylinder(p = {}) {
    this._assertReady();
    const x = p.x || 0, y = p.y || 0, z = p.z || 0;
    const r = p.r === undefined ? 1 : p.r;
    const h = p.h === undefined ? 10 : p.h;
    const maker = new this.oc.BRepPrimAPI_MakeCylinder_1(r, h);
    let shape = maker.Shape();
    maker.delete();
    // `r`/`h` map 1:1 to the real radius/height (volume = π·r²·h, verified) and the
    // cylinder spans z=0..h along +Z; translate by -h/2 to center it on (x, y, z).
    shape = this._transformShape(shape, { dx: x, dy: y, dz: z - h / 2 });
    return this._store(shape);
  }

  createSphere(p = {}) {
    this._assertReady();
    const x = p.x || 0, y = p.y || 0, z = p.z || 0;
    const r = p.r === undefined ? 1 : p.r;
    const maker = new this.oc.BRepPrimAPI_MakeSphere_1(r);
    let shape = maker.Shape();
    maker.delete();
    shape = this._transformShape(shape, { dx: x, dy: y, dz: z });
    return this._store(shape);
  }

  createCone(p = {}) {
    this._assertReady();
    const x = p.x || 0, y = p.y || 0, z = p.z || 0;
    const r1 = p.r1 === undefined ? 1 : p.r1;
    const r2 = p.r2 === undefined ? 0 : p.r2;
    const h = p.h === undefined ? 10 : p.h;
    const maker = new this.oc.BRepPrimAPI_MakeCone_1(r1, r2, h);
    let shape = maker.Shape();
    maker.delete();
    // base center at z, apex/top at z+h (z is the bottom-center height)
    shape = this._transformShape(shape, { dx: x, dy: y, dz: z });
    return this._store(shape);
  }

  createTorus(p = {}) {
    this._assertReady();
    const x = p.x || 0, y = p.y || 0, z = p.z || 0;
    const r1 = p.r1 === undefined ? 2 : p.r1; // main radius
    const r2 = p.r2 === undefined ? 0.5 : p.r2; // tube radius
    const maker = new this.oc.BRepPrimAPI_MakeTorus_1(r1, r2);
    let shape = maker.Shape();
    maker.delete();
    shape = this._transformShape(shape, { dx: x, dy: y, dz: z });
    return this._store(shape);
  }

  /* -------------------------------------------------------------- boolean -- */

  boolean(op, aId, bIdOrIds) {
    this._assertReady();
    const Ctor = {
      fuse: this.oc.BRepAlgoAPI_Fuse_3,
      cut: this.oc.BRepAlgoAPI_Cut_3,
      common: this.oc.BRepAlgoAPI_Common_3,
    }[op];
    if (!Ctor) throw new Error(`未知布尔运算: ${op}`);

    let acc = this._assertBody(aId); // Map-owned: do not delete
    let accOwned = false;            // true once acc is an intermediate result we created
    const tools = Array.isArray(bIdOrIds) ? bIdOrIds : [bIdOrIds];
    for (const bId of tools) {
      const tool = this._assertBody(bId);
      const algo = new Ctor(acc, tool);
      const result = algo.Shape();
      algo.delete();
      if (accOwned) acc.delete();
      acc = result;
      accOwned = true;
    }

    if (acc.IsNull()) {
      acc.delete();
      throw new Error(`布尔运算失败: ${op}`);
    }
    if (op === 'common' && this._volume(acc) <= 1e-9) {
      acc.delete();
      throw new Error('布尔运算失败: 无重叠区域');
    }
    return this._store(acc);
  }

  /* ------------------------------------------------------------ transform -- */

  transform(id, t = {}) {
    this._assertReady();
    const shape = this._assertBody(id);
    const newShape = this._transformShape(shape, t);
    shape.delete();
    this._bodies.set(id, newShape);
  }

  copy(id) {
    this._assertReady();
    const shape = this._assertBody(id);
    const identity = new this.oc.gp_Trsf_1();
    const builder = new this.oc.BRepBuilderAPI_Transform_2(shape, identity, true);
    const newShape = builder.Shape();
    builder.delete();
    identity.delete();
    return this._store(newShape);
  }

  /* ------------------------------------------------------------------ mesh -- */

  mesh(id, opts = {}) {
    this._assertReady();
    return this._meshShape(this._assertBody(id), opts);
  }

  _meshShape(shape, opts = {}) {
    const linear = opts.linearDeflection === undefined ? 0.5 : opts.linearDeflection;
    const angular = opts.angularDeflection === undefined ? 0.5 : opts.angularDeflection;

    const mesher = new this.oc.BRepMesh_IncrementalMesh_2(shape, linear, false, angular, false);
    const TopAbs = this.oc.TopAbs_ShapeEnum;
    const explorer = new this.oc.TopExp_Explorer_2(shape, TopAbs.TopAbs_FACE, TopAbs.TopAbs_SHAPE);

    const positions = [];
    const indices = [];
    let offset = 0;
    while (explorer.More()) {
      const faceShape = explorer.Current();          // borrowed
      const face = this.oc.TopoDS.Face_1(faceShape); // borrowed view
      const loc = new this.oc.TopLoc_Location_1();   // owned
      const triHandle = this.oc.BRep_Tool.Triangulation(face, loc); // owned handle
      if (!triHandle.IsNull()) {
        const tri = triHandle.get();                 // borrowed
        const nbNodes = tri.NbNodes();
        const nbTri = tri.NbTriangles();
        const trsf = loc.Transformation();           // borrowed
        const nodeArr = tri.Nodes();                 // borrowed
        for (let i = 1; i <= nbNodes; i++) {
          const p = nodeArr.Value(i);                // borrowed
          const tp = p.Transformed(trsf);            // owned copy
          positions.push(tp.X(), tp.Y(), tp.Z());
          tp.delete();
        }
        const triArr = tri.Triangles();              // borrowed
        for (let i = 1; i <= nbTri; i++) {
          const t = triArr.Value(i);                 // borrowed
          const v1 = t.Value(1), v2 = t.Value(2), v3 = t.Value(3);
          indices.push(offset + (v1 - 1), offset + (v2 - 1), offset + (v3 - 1));
        }
        offset += nbNodes;
      }
      triHandle.delete();
      loc.delete();
      explorer.Next();
    }
    explorer.delete();
    mesher.delete();

    if (positions.length === 0 || indices.length === 0) {
      throw new Error('网格化失败: 未产生三角形');
    }
    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
    };
  }

  /* -------------------------------------------------------------- measure -- */

  volume(id) {
    this._assertReady();
    return this._volume(this._assertBody(id));
  }

  bbox(id) {
    this._assertReady();
    return this._bbox(this._assertBody(id));
  }

  /* -------------------------------------------------------------- export --- */

  exportSTL(idOrIds) {
    this._assertReady();
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    if (ids.length === 0) throw new Error('exportSTL: 无 body');

    let shape;
    let ownsShape = false;
    if (ids.length === 1) {
      shape = this._assertBody(ids[0]);
    } else {
      // 多个 body：合并为 TopoDS_Compound 一次性导出
      const builder = new this.oc.BRep_Builder();
      shape = new this.oc.TopoDS_Compound();
      builder.MakeCompound(shape);
      for (const id of ids) {
        builder.Add(shape, this._assertBody(id));
      }
      builder.delete();
      ownsShape = true;
    }

    const { positions, indices } = this._meshShape(shape, {});
    if (ownsShape) shape.delete();
    return this._buildBinarySTL(positions, indices);
  }

  _buildBinarySTL(positions, indices) {
    const triCount = indices.length / 3;
    const headerText = 'xbcad binary STL';
    const buffer = new ArrayBuffer(84 + triCount * 50);
    const view = new DataView(buffer);
    for (let i = 0; i < 80; i++) {
      view.setUint8(i, i < headerText.length ? headerText.charCodeAt(i) : 0);
    }
    view.setUint32(80, triCount, true);
    let off = 84;
    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
      const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
      const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
      // normal = (b-a) x (c-a)
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; }
      view.setFloat32(off, nx, true); off += 4;
      view.setFloat32(off, ny, true); off += 4;
      view.setFloat32(off, nz, true); off += 4;
      for (const [vx, vy, vz] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
        view.setFloat32(off, vx, true); off += 4;
        view.setFloat32(off, vy, true); off += 4;
        view.setFloat32(off, vz, true); off += 4;
      }
      view.setUint16(off, 0, true); off += 2;
    }
    return new Uint8Array(buffer);
  }

  exportSTEP(ids) {
    this._assertReady();
    const list = Array.isArray(ids) ? ids : [ids];
    if (list.length === 0) throw new Error('exportSTEP: 无 body');

    const builder = new this.oc.BRep_Builder();
    const compound = new this.oc.TopoDS_Compound();
    builder.MakeCompound(compound);
    for (const id of list) {
      builder.Add(compound, this._assertBody(id));
    }
    builder.delete();

    const writer = new this.oc.STEPControl_Writer_1();
    writer.Transfer(compound, this.oc.STEPControl_StepModelType.STEPControl_AsIs, true);
    // NOTE: OCC's STEP reader/writer in this WASM build only accepts filenames of
    // up to 5 characters before the extension (longer names yield IFSelect_RetError).
    const filename = 'out.step';
    writer.Write(filename);
    writer.delete();
    compound.delete();

    const bytes = this.oc.FS.readFile('/' + filename, { encoding: 'binary' });
    return new Uint8Array(bytes);
  }

  importSTEP(bytes) {
    this._assertReady();
    const filename = 'in.step';
    this.oc.FS.writeFile('/' + filename, new Uint8Array(bytes));

    const reader = new this.oc.STEPControl_Reader_1();
    const status = reader.ReadFile(filename);
    if (status.value !== 1) { // IFSelect_RetDone
      reader.delete();
      throw new Error('STEP 读取失败');
    }
    const nbRoots = reader.TransferRoots();
    if (nbRoots <= 0) {
      reader.delete();
      throw new Error('STEP 文件不含可转换实体');
    }

    const oneShape = reader.OneShape();
    const TopAbs = this.oc.TopAbs_ShapeEnum;
    const resultIds = [];
    // Enumerate solid sub-shapes (also yields a single solid itself).
    const explorer = new this.oc.TopExp_Explorer_2(oneShape, TopAbs.TopAbs_SOLID, TopAbs.TopAbs_SHAPE);
    while (explorer.More()) {
      const solidShape = explorer.Current(); // borrowed
      const solid = this.oc.TopoDS.Solid_1(solidShape);
      // Keep an independent copy so the reader (and its model) can be released safely.
      const identity = new this.oc.gp_Trsf_1();
      const copyBuilder = new this.oc.BRepBuilderAPI_Transform_2(solid, identity, true);
      const copy = copyBuilder.Shape();
      copyBuilder.delete();
      identity.delete();
      resultIds.push(this._store(copy));
      explorer.Next();
    }
    explorer.delete();

    if (resultIds.length === 0) {
      oneShape.delete();
      reader.delete();
      throw new Error('STEP 文件不含实体 (SOLID)');
    }
    oneShape.delete();
    reader.delete();
    return resultIds;
  }

  /* ---------------------------------------------------------- fillet/chamfer */

  fillet(id, radius) {
    this._assertReady();
    if (!(radius > 0)) throw new Error('圆角半径必须大于 0');
    const shape = this._assertBody(id);
    // 半径预检：OCC 失败会抛 C++ 异常，而浏览器构建缺少 ___cxa_is_pointer_type 会直接崩溃，
    // 因此在调用前做几何可行性检查，避免进入失败路径
    const bb = this.bbox(id);
    const minDim = Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY, bb.maxZ - bb.minZ);
    if (radius >= minDim / 2) {
      throw new Error(`圆角失败：半径 ${radius} 过大（实体最小尺寸 ${Math.round(minDim)}，半径应 < ${Math.round(minDim / 2)}）`);
    }
    const maker = new this.oc.BRepFilletAPI_MakeFillet(shape, this.oc.ChFi3d_FilletShape.ChFi3d_Rational);
    const TopAbs = this.oc.TopAbs_ShapeEnum;
    const explorer = new this.oc.TopExp_Explorer_2(shape, TopAbs.TopAbs_EDGE, TopAbs.TopAbs_SHAPE);
    while (explorer.More()) {
      const edgeShape = explorer.Current();          // borrowed
      const edge = this.oc.TopoDS.Edge_1(edgeShape); // borrowed view
      maker.Add_2(radius, edge);
      explorer.Next();
    }
    explorer.delete();
    maker.Build();
    if (!maker.IsDone()) {
      maker.delete();
      throw new Error(`圆角失败：半径 ${radius} 对该几何体过大或棱边无法构造圆角（请减小半径重试）`);
    }
    const result = maker.Shape();
    maker.delete();
    return this._store(result);
  }

  chamfer(id, distance) {
    this._assertReady();
    if (!(distance > 0)) throw new Error('倒角距离必须大于 0');
    const shape = this._assertBody(id);
    const bb = this.bbox(id);
    const minDim = Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY, bb.maxZ - bb.minZ);
    if (distance >= minDim / 2) {
      throw new Error(`倒角失败：距离 ${distance} 过大（实体最小尺寸 ${Math.round(minDim)}，距离应 < ${Math.round(minDim / 2)}）`);
    }
    const maker = new this.oc.BRepFilletAPI_MakeChamfer(shape);
    const TopAbs = this.oc.TopAbs_ShapeEnum;
    const explorer = new this.oc.TopExp_Explorer_2(shape, TopAbs.TopAbs_EDGE, TopAbs.TopAbs_SHAPE);
    while (explorer.More()) {
      const edgeShape = explorer.Current();          // borrowed
      const edge = this.oc.TopoDS.Edge_1(edgeShape); // borrowed view
      maker.Add_2(distance, edge);
      explorer.Next();
    }
    explorer.delete();
    maker.Build();
    if (!maker.IsDone()) {
      maker.delete();
      throw new Error(`倒角失败: distance=${distance}`);
    }
    const result = maker.Shape();
    maker.delete();
    return this._store(result);
  }

  /* ------------------------------------------------------------- lifecycle -- */

  deleteBody(id) {
    this._assertReady();
    const shape = this._bodies.get(id);
    if (shape) {
      shape.delete();
      this._bodies.delete(id);
    }
  }

  bodyCount() {
    return this._bodies.size;
  }

  dispose() {
    if (this._disposed) return;
    for (const shape of this._bodies.values()) {
      try { shape.delete(); } catch (_) { /* ignore */ }
    }
    this._bodies.clear();
    this._disposed = true;
  }
}
