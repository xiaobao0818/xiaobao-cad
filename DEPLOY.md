# 服务器部署（jinghongyouxi.com）

部署位置：`/www/wwwroot/jinghongyouxi.com/cad/`（子目录，**不影响原网站**）
线上地址：https://jinghongyouxi.com/cad/

## 环境事实（决定部署方式的三个约束）

1. 站点 nginx 配置有一条全局规则：`location ~* /(\.git|...|node_modules|runtime)/ { return 404; }`
   → **任何路径含 `node_modules` 都会 404**，依赖目录必须改名（用 `vendor/`）。
2. nginx 的 mime.types 未映射 `.mjs`（返回 `application/octet-stream`），浏览器 `import()` ES 模块
   要求 JavaScript MIME → **部署副本必须把 `.mjs` 改名为 `.js`**（本地 python http.server 无此问题）。
3. 服务器无 rsync，用 `tar` 管道经 SSH 传输；macOS tar 会带 AppleDouble `._*` 文件，传完必须清理。

## 一键更新流程（在项目根目录执行）

```bash
# 1) 构建部署包（路径改写 + mjs 改名，仅改 /tmp 副本，不动项目源码）
rm -rf /tmp/xbcad-deploy && mkdir -p /tmp/xbcad-deploy/cad/{css,js,vendor,training,knowledge,samples}
cp index.html /tmp/xbcad-deploy/cad/
cp -R css/* js/ samples/ /tmp/xbcad-deploy/cad/
cp knowledge/data.js /tmp/xbcad-deploy/cad/knowledge/
sed 's|from '\''./memory.mjs'\''|from '\''./memory.js'\''|' training/knowledge.mjs > /tmp/xbcad-deploy/cad/training/knowledge.js
sed "s|from '../training/pumpdesign.mjs'|from '../training/pumpdesign.js'|; s|from '../training/knowledge.mjs'|from '../training/knowledge.js'|" js/ai.js > /tmp/xbcad-deploy/cad/js/ai.js
cp training/pumpdesign.mjs training/memory.mjs /tmp/xbcad-deploy/cad/training/
mv /tmp/xbcad-deploy/cad/training/pumpdesign.mjs /tmp/xbcad-deploy/cad/training/pumpdesign.js
mv /tmp/xbcad-deploy/cad/training/memory.mjs /tmp/xbcad-deploy/cad/training/memory.js
mkdir -p /tmp/xbcad-deploy/cad/vendor
cp -R node_modules/three /tmp/xbcad-deploy/cad/vendor/three
mkdir -p /tmp/xbcad-deploy/cad/vendor/opencascade.js
cp -R node_modules/opencascade.js/dist /tmp/xbcad-deploy/cad/vendor/opencascade.js/dist
mkdir -p /tmp/xbcad-deploy/cad/vendor/@mlightcad/libredwg-web
cp -R node_modules/@mlightcad/libredwg-web/{dist,wasm} /tmp/xbcad-deploy/cad/vendor/@mlightcad/libredwg-web/
sed -i '' 's|/node_modules/three/|./vendor/three/|g' /tmp/xbcad-deploy/cad/index.html
sed -i '' "s|'/node_modules/@mlightcad/libredwg-web/dist/libredwg-web.js'|'../vendor/@mlightcad/libredwg-web/dist/libredwg-web.js'|g; s|'/node_modules/@mlightcad/libredwg-web/wasm'|'./vendor/@mlightcad/libredwg-web/wasm'|g" /tmp/xbcad-deploy/cad/js/dwg.js
sed -i '' "s|'/node_modules/opencascade.js/dist/' + f|'./vendor/opencascade.js/dist/' + f|g; s|'/node_modules/opencascade.js/dist/opencascade.wasm.js'|'../../vendor/opencascade.js/dist/opencascade.wasm.js'|g" /tmp/xbcad-deploy/cad/js/three-dim/occ-kernel.js
sed -i '' "s|'/node_modules/opencascade.js/dist/' + f|'./vendor/opencascade.js/dist/' + f|g" /tmp/xbcad-deploy/cad/js/three-dim/app3d.js

# 2) 上传（tar over ssh，传完清理 ._* 垃圾文件并设权限）
KEY="/Users/zhangxiaobao/Desktop/小宝-cad/惊鸿服务器-SSH私钥.key"
# 先整体备份线上旧版本，失败可回滚：
ssh -i "$KEY" -o IdentitiesOnly=yes root@8.163.80.108 'rm -rf /www/wwwroot/jinghongyouxi.com/cad.old && mv /www/wwwroot/jinghongyouxi.com/cad /www/wwwroot/jinghongyouxi.com/cad.old 2>/dev/null; true'
cd /tmp/xbcad-deploy && tar cf - cad | ssh -i "$KEY" -o IdentitiesOnly=yes root@8.163.80.108 \
  'tar xf - -C /www/wwwroot/jinghongyouxi.com && find /www/wwwroot/jinghongyouxi.com/cad -name "._*" -delete && rm -f /www/wwwroot/jinghongyouxi.com/._cad && chown -R www:www /www/wwwroot/jinghongyouxi.com/cad && find /www/wwwroot/jinghongyouxi.com/cad -type d -exec chmod 755 {} + && find /www/wwwroot/jinghongyouxi.com/cad -type f -exec chmod 644 {} +'
# 回滚方法：ssh ... 'rm -rf cad && mv cad.old cad'

# 3) 验证
curl -skI https://jinghongyouxi.com/cad/ | head -2
curl -skI https://jinghongyouxi.com/cad/vendor/opencascade.js/dist/opencascade.wasm.wasm | grep -i content-type   # 应 application/wasm
curl -skI https://jinghongyouxi.com/cad/training/knowledge.js | grep -i content-type                            # 应 application/javascript
md5sum /www/wwwroot/jinghongyouxi.com/index.html    # 应保持 d26a976f09966d4810db7536aaf7a104
```

## 路径改写对照（浏览器解析基准）

| 文件 | 原路径 | 改写为 | 解析基准 |
|---|---|---|---|
| index.html importmap | `/node_modules/three/` | `./vendor/three/` | 页面 |
| js/dwg.js import | `/node_modules/@mlightcad/...dist` | `../vendor/@mlightcad/...dist` | 模块(js/) |
| js/dwg.js LibreDwg.create | `/node_modules/@mlightcad/...wasm` | `./vendor/@mlightcad/...wasm` | 页面(fetch) |
| js/three-dim/occ-kernel.js locateFile | `/node_modules/opencascade.js/dist/` | `./vendor/opencascade.js/dist/` | 页面(fetch) |
| js/three-dim/occ-kernel.js glueUrl | `/node_modules/.../opencascade.wasm.js` | `../../vendor/.../opencascade.wasm.js` | 模块(js/three-dim/) |
| js/three-dim/app3d.js locateFile | `/node_modules/opencascade.js/dist/` | `./vendor/opencascade.js/dist/` | 页面(fetch) |

注意 `import()` 按**模块基准**解析、`fetch/locateFile` 按**页面基准**解析，两者改写深度不同。
