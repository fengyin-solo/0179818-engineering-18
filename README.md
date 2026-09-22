## How to Run

1. 确保已安装 Docker 和 Docker Compose

2. 在项目根目录执行（可注入构建版本号）：
```bash
BUILD_ID=1.0.0-$(git rev-parse --short HEAD) docker-compose up --build -d
```

3. 访问应用：
- 用户端: http://localhost:8081

4. 停止服务：
```bash
docker-compose down
```

## 发布配置（本地与容器共用一套）

缓存、压缩、安全响应头、SPA 路由回退的唯一配置来源是
`frontend-user/deploy/serve.config.js`，本地 Vite（dev / preview）与容器内 Nginx 行为一致：

- `deploy/nginx.conf` 由配置生成（**不要手改**）：`cd frontend-user && npm run generate:nginx`
- `deploy/vite-shared-serve.mjs` 是 Vite 插件，让 `npm run dev` / `npm run preview`
  使用同样的 gzip、安全头与缓存规则
- 版本号 `X-App-Version`：本地为 `<package版本>-<git短SHA>`，本地可显式设置 `BUILD_ID`；
  镜像构建时由 Dockerfile 的 `--build-arg BUILD_ID=...` 注入

缓存策略：

| 资源 | 策略 |
|------|------|
| `index.html`（及 SPA 回退） | `no-cache`，新版本发布后立即生效 |
| `/assets/*`（Vite 指纹资源） | 1 年 `immutable`，内容变化即换文件名 |
| `public/` 静态资源（音频等） | 1 天，需重新验证 |

### 发布前校验（可重复）

```bash
cd frontend-user
npm run release:check
```

分三个阶段，失败时会标明具体环节：

1. **config-drift** — 检查 `nginx.conf` 与 `serve.config.js` 是否一致
2. **build-twice** — 用两个版本号各构建一次，验证指纹资源随版本换名、
   `index.html` 引用齐全、同版本重复构建产物一致
3. **serve** — 启动真实 preview 服务，逐项断言：入口页面 / 样式 / 脚本可加载、
   gzip、安全头、三类缓存头、深层路由 SPA 回退

### 发布流水线

`.github/workflows/release.yml`：

- 任意推送 / PR：`check:nginx` + `release:check`
- main 分支：额外构建镜像验证 Dockerfile（不推送）
- 推送 `v*` 标签：构建并推送镜像到 GHCR，`BUILD_ID=<tag>-<短SHA>`

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
│   ├── index.html          # HTML 模板
│   ├── Dockerfile          # Docker 构建文件
│   ├── deploy/             # 发布配置（本地与容器共用）
│   │   ├── serve.config.js      # 唯一配置源：缓存/压缩/安全头/回退
│   │   ├── generate-nginx.mjs  # 配置 -> nginx.conf 生成器
│   │   ├── nginx.conf           # 生成的 Nginx 配置（勿手改）
│   │   ├── vite-shared-serve.mjs # Vite 共享规则插件
│   │   └── build-id.mjs         # 版本号解析
│   ├── scripts/
│   │   └── release-check.mjs    # 发布前可重复校验
│   ├── package.json        # 项目配置
│   └── vite.config.js      # Vite 配置
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

## 频率区域说明

- **低频区**：基频 ~ 4倍频
- **中频区**：5倍频 ~ 8倍频
- **高频区**：9倍频 ~ 13倍频

这三个区域共享同一个基频，用于分析古琴音色在不同频率范围的特征。
