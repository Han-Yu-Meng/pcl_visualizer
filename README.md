# PCD 点云检视 · 横平竖直辅助面

纯前端（HTML + JS，无后端、无上传）的点云可视化工具，用于检查**地面是否水平、墙面是否竖直**。
可直接部署到 GitHub Pages。

## 功能

- **上传 / 拖放 .pcd**：支持 DATA ascii、binary、binary_compressed（LZF）三种编码；
  自动读取 x y z、rgb / rgba、intensity 字段，支持 organized（WIDTH × HEIGHT）点云、
  COUNT > 1、NaN 点过滤，以及 PCL 带对齐填充的二进制行。文件仅在浏览器内解析，**不会上传**。
- **辅助平面**：可添加多个（默认一个水平面 + 一个竖直面）。每个平面可设置基准方向（±X / ±Y / ±Z）、
  沿法向偏移、两轴倾角、网格间距与范围、颜色与透明度，并显示带刻度网格、边框和法向箭头。
- **平面拟合**：
  - 「拟合附近点」：对当前平面附近做最小二乘平面拟合 + 内点迭代精化。
  - 「自动找主平面」：RANSAC 找点云中最大的平面，并自动套用到方向最匹配的平面上。
  - 实时读出**偏离理想水平 / 竖直方向的角度**、平面方程、RMS、最大偏差、±1 cm / ±2 cm 内点占比。
- **辅助线**：点击平面即可放置横向线（沿 X / Y）、竖直线（沿 Z）或三轴十字线；
  也可按坐标手动添加，支持刻度标记。
- **偏差分析**：默认按「平面偏差」着色，用深蓝→青→绿→琥珀→红的 5 段色标显示偏差（绿=共面）；
  只对 ±0.1 m（可用「偏差着色 ±」调整）范围内的点上色，超出范围的点显示为半透明深灰，
  可用「外部点不透明度」调整其淡化程度。「剖面厚度」只显示距平面 ±厚度 内的点，便于观察是否共面。
- 高度 / 强度 / RGB / 单色着色、点大小与不透明度、包围盒、坐标轴罗盘、视角预设、截图、
  检查报告导出（.txt）。

> 判断方法：把水平面移到地面附近 → 点「拟合附近点」→ 看「偏离理想方向」角度；
> 竖直面同理贴到墙面。角度越接近 0° 越横平竖直。内置的「示例房间」地面约 0.67°、
> 墙面约 1.03° 倾斜，可直接用来验证。

## 坐标约定

Z 轴为竖直方向（与 PCL / ROS 一致）：水平面法向为 +Z，竖直面法向为 ±X / ±Y。
若你的点云是 Y-up，可先用外部工具旋转，或修改 index.html / app.js 中的坐标约定。

## 本地运行

ES module 需要通过 HTTP 打开（直接双击 file:// 会被 CORS 拦截）：

~~~bash
cd pcd_visualizer
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
~~~

Three.js 通过 importmap 从 unpkg CDN 加载（固定版本 0.160.0），首次打开需要联网。
若需完全离线，把 three.module.js 与 examples/jsm/controls/OrbitControls.js 下载到本地，
并修改 index.html 中的 importmap 路径即可。

## 部署到 GitHub Pages

1. 把本目录的 index.html、style.css、app.js、pcd.js、demo.js 推到仓库
   （tests/、package.json、README.md 可一并推送，不影响页面）。
2. 仓库 **Settings → Pages → Build and deployment**：
   - Source 选 **Deploy from a branch**，分支选 main，目录选 / (root)；
   - 或者把文件放进 docs/ 目录后选 /docs。
3. 保存后访问 https://&lt;用户名&gt;.github.io/&lt;仓库名&gt;/。

无需构建步骤、无需 Node、无需后端。若使用自定义域名且希望完全离线，请把 Three.js 一并放进仓库。

## 测试

~~~bash
npm test        # PCD 解析器单元测试（三种编码、rgb、NaN、填充行、LZF 回引用等）
~~~

## 目录

| 文件 | 作用 |
| --- | --- |
| index.html | 页面结构、CDN importmap |
| style.css | 界面样式 |
| app.js | Three.js 渲染、辅助面 / 线、拟合与偏差分析 |
| pcd.js | 独立的 PCD 解析器（无依赖，可在 Node 中单独使用） |
| demo.js | 示例房间点云与三种 PCD 编码生成器（也是测试夹具） |
| tests/pcd.test.js | 解析器单元测试 |