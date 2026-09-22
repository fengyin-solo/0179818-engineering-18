## How to Run

1. 确保已安装 Docker 和 Docker Compose

2. 在项目根目录执行：
```bash
docker-compose up --build -d
```

3. 访问应用：
- 用户端: http://localhost:8081

4. 停止服务：
```bash
docker-compose down
```

## Services

| 服务名称 | 端口 | 描述 |
|---------|------|------|
| frontend-user | 8081 | 古琴音频分析软件用户端 |

## 测试

### 测试音频

项目提供了测试音频文件 `frontend-user/public/test-guqin.wav`，可直接用于测试：
- 基频: 130.81 Hz (接近 C3)
- 时长: 3 秒
- 包含 13 次谐波，模拟古琴音色

### 功能测试

1. 上传音频文件
   - 支持 MP3、WAV、OGG 等常见音频格式
   - 文件大小建议不超过 10MB
   - 音频时长建议在 5 秒以内

2. 区间选择
   - 使用输入框精确输入起止时间（毫秒）
   - 使用滑块快速选择区间
   - 实时显示选中时长

3. 音频分析
   - 点击"分析音频"按钮开始分析
   - 自动检测基频
   - 显示最多 13 倍频

4. 图表验证
   - 波形图：显示选中区间的音频波形
   - 频谱图：显示基频和倍频的相对强度
   - 热力图：显示声强随时间的变化
   - 频率区域图：分别显示低频区、中频区、高频区

### 浏览器兼容性

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

---

# 古琴音频分析软件

专为斫琴师设计的音频频谱分析工具，用于分析古琴音色的基频、倍频和声强变化。

## 功能特性

- **音频上传**：支持 MP3、WAV、OGG 等常见音频格式
- **精确截取**：以毫秒为单位精确选择分析区间
- **基频检测**：自动检测音频的基频
- **倍频分析**：显示最多 13 倍频，过滤其他频率
- **可视化图表**：
  - 波形图：显示音频波形
  - 频谱图：显示基频和倍频的强度分布
  - 热力图：显示声强随时间的变化
  - 频率区域图：分别显示低频区、中频区、高频区

## 技术栈

- 原生 JavaScript (ES6+)
- Web Audio API
- Chart.js
- Vite
- Nginx
- Docker

## 项目结构

```
├── frontend-user/          # 用户端前端项目
│   ├── src/
│   │   ├── modules/        # 功能模块
│   │   │   ├── audioAnalyzer.js   # 音频分析器
│   │   │   ├── chartManager.js    # 图表管理器
│   │   │   └── uiController.js    # UI 控制器
│   │   ├── utils/          # 工具函数
│   │   │   └── logger.js   # 日志工具
│   │   ├── styles/         # 样式文件
│   │   │   └── main.css    # 主样式
│   │   └── main.js         # 入口文件
│   ├── deploy/             # 发布配置（唯一数据源）
│   │   ├── release.config.mjs        # 缓存/压缩/安全头/SPA 回退配置
│   │   ├── render-nginx-conf.mjs     # 生成容器 nginx.conf
│   │   └── vite-release-plugin.mjs   # 本地服务应用同一套配置
│   ├── scripts/
│   │   └── verify-release.mjs        # 发布前分环节校验
│   ├── index.html          # HTML 模板
│   ├── Dockerfile          # Docker 构建文件（构建期生成 nginx.conf）
│   ├── package.json        # 项目配置
│   └── vite.config.js      # Vite 配置
├── .github/workflows/
│   └── release.yml         # 发布流水线（校验 → 镜像构建 → 冒烟）
├── docker-compose.yml      # Docker Compose 配置
├── .gitignore              # Git 忽略文件
└── README.md               # 项目说明
```

## 本地开发

```bash
cd frontend-user
npm install
npm run dev
```

访问 http://localhost:8081

## 发布配置与发布流水线

发布相关的配置（静态资源缓存、压缩、安全响应头、SPA 路由回退）已独立为
**唯一数据源** `frontend-user/deploy/release.config.mjs`，本地与容器共用：

| 消费方 | 方式 |
|--------|------|
| 本地 `npm run preview` | `deploy/vite-release-plugin.mjs` 将配置应用到 Vite 服务 |
| 容器 nginx | 镜像构建期由 `deploy/render-nginx-conf.mjs` 生成 `nginx.conf`（生成物，勿手改、不入库） |
| 发布前校验 | `scripts/verify-release.mjs` 按同一配置逐项断言 |

修改发布行为只需改 `release.config.mjs`，三处同时生效。

### 发布前校验

```bash
cd frontend-user
npm run verify:release        # 可用 APP_VERSION=x.y.z 指定版本号
```

依次执行以下环节，任一失败即以非零码退出并标明具体环节：

1. **build** — 构建产物（vite build）
2. **artifacts** — 产物完整性：index.html、版本标识、资源引用与内容哈希
3. **nginx-conf** — 容器 nginx 配置可由共享配置正确生成
4. **serve** — 启动本地发布服务（与容器同一套发布配置）
5. **page** — 页面可加载、安全响应头、HTML 不缓存、gzip
6. **assets** — 样式/脚本可加载、内容与产物一致、长缓存、gzip
7. **spa-fallback** — 单页路由回退到 index.html
8. **cache-busting** — 版本更新后资源哈希（缓存标识）随之变化

### CI 流水线

`.github/workflows/release.yml`（push 到 main 或 PR 时触发）：

```
npm ci → npm run verify:release → docker build → 容器冒烟测试
```

本地执行等价于：

```bash
cd frontend-user
npm ci && npm run verify:release
cd .. && docker-compose up --build -d
```

## 频率区域说明

- **低频区**：基频 ~ 4倍频
- **中频区**：5倍频 ~ 8倍频
- **高频区**：9倍频 ~ 13倍频

这三个区域共享同一个基频，用于分析古琴音色在不同频率范围的特征。
