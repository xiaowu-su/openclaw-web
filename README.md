# OpenClaw Web Dashboard

轻量级 OpenClaw 状态监控面板，纯 Node.js，无需外部依赖。

## 快速启动

```bash
# 安装依赖
npm install ws

# 启动
./ctl.sh start

# 访问
# 状态面板: http://localhost:60601
```

## 管理命令

```bash
./ctl.sh start     # 启动服务
./ctl.sh stop      # 停止服务
./ctl.sh restart   # 重启服务
./ctl.sh status    # 查看状态
./ctl.sh logs      # 查看日志
./ctl.sh install   # 安装为 systemd 服务（需 root）
./ctl.sh uninstall # 卸载 systemd 服务
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `STATUS_PORT` | `60601` | 监听端口 |

## 功能

### 🏠 状态面板 (`/`)

**实时监控**
- Gateway 进程状态 & PID
- CPU 负载 & 核心利用率
- 内存使用（总量/已用/可用，含缓存清理）
- 磁盘使用
- 系统运行时间
- 网络连接数
- 系统信息（主机名、内核、处理器、交换分区）
- 每 30 秒自动刷新

**网关控制**
- ▶ 启动 / ⏹ 停止 / 🔄 重启 OpenClaw 网关
- 操作结果实时反馈
- 当前访问 IP、Token（支持显示/隐藏切换）、面板链接（自动携带 Token）

**模型管理**
- 当前模型高亮显示
- 查看已配置模型列表，标记当前使用的模型
- 一键切换默认模型
- 添加新模型（ID、名称、Provider、API Key、Base URL）
- 删除模型

### 📱 侧滑菜单

左上角汉堡菜单按钮，支持：
- 📈 使用情况 — Token 消耗与上下文用量统计
- 📡 消息渠道 — 已接入 & 可接入的消息平台
- ⚙️ 面板设置 — OpenClaw 路径配置与面板信息

### 📈 使用情况

- 会话 Token 用量（输入 / 输出 / 缓存读取 / 总计）
- 上下文窗口消耗百分比与进度条
- 剩余 Token 数量
- Provider 使用统计

### 📡 消息渠道

- 已接入平台列表（显示连接状态）
- 可接入平台列表（20+ 平台，附接入文档链接）
- 支持平台：Telegram、Discord、WhatsApp、Signal、Slack、飞书、LINE、iMessage、IRC、Matrix、Mattermost、MS Teams、Twitch、Zalo、Nostr、BlueBubbles、Synology Chat、Nextcloud Talk 等

### ⚙️ 面板设置

- OpenClaw 主目录路径配置（持久化到 `.panel-settings.json`）
- 配置文件路径自动推导与复制
- 面板信息：端口、版本号、刷新间隔

### 🎨 界面个性化

- 🖼️ 自定义壁纸：URL 输入 / 本地图片上传 / 拖拽上传 / 预设壁纸
- 🎨 自定义 Logo：Emoji 选择 / 本地图片上传 / 自定义标题和副标题
- 🔆 页面透明度：滑块调节 (30%~100%) / 快捷预设
- 🌙 日夜主题切换
- 所有设置持久化到 localStorage

### 📱 移动端适配

- 响应式布局，自动适配手机屏幕
- 指标卡片 2 列 / 单列切换
- 信息栏、按钮自适应
- 弹窗宽度自适应

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 状态面板 |
| `GET` | `/api/status` | JSON 系统状态 |
| `GET` | `/api/gateway-info` | 网关连接信息（端口、Token、IP） |
| `POST` | `/api/clear-cache` | 清理系统内存缓存 |
| `POST` | `/api/gateway/start` | 启动网关 |
| `POST` | `/api/gateway/stop` | 停止网关 |
| `POST` | `/api/gateway/restart` | 重启网关 |
| `GET` | `/api/models` | 获取模型列表 |
| `POST` | `/api/models/switch` | 切换模型 |
| `POST` | `/api/models/add` | 添加模型 |
| `POST` | `/api/models/delete` | 删除模型 |
| `GET` | `/api/usage` | Token 消耗与使用统计 |
| `GET` | `/api/channels` | 消息渠道列表（已接入 & 可接入） |
| `GET` | `/api/settings` | 面板设置信息 |
| `POST` | `/api/settings/path` | 更新 OpenClaw 路径配置 |

## 技术栈

- **后端**: Node.js（内置模块，零依赖）
- **前端**: 纯 HTML/CSS/JS（无框架）
- **数据**: 读取 `/proc`、执行系统命令、解析 OpenClaw 配置

## License

MIT
