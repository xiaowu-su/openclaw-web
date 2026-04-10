# OpenClaw Web Dashboard

轻量级 OpenClaw 状态监控面板，纯 Node.js。

## 快速启动

```bash
# 安装依赖
npm install

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

### 状态面板 (`/`)

**实时监控**
- Gateway 进程状态 & PID
- CPU 负载 & 核心利用率
- 内存使用（总量/已用/可用，含缓存清理）
- 磁盘使用
- 系统运行时间
- Top 进程（按 CPU 排序）
- 活跃会话
- 网络连接数
- 系统信息
- 每 30 秒自动刷新

**网关控制**
- ▶ 启动 / ⏹ 停止 / 🔄 重启 OpenClaw 网关
- 操作结果实时反馈
- 显示当前访问 IP、Token、面板链接

**模型管理**
- 当前模型高亮显示
- 查看已配置模型列表，标记当前使用的模型
- 一键切换默认模型
- 添加新模型（ID、名称、Provider、API Key、Base URL）
- 删除模型

**界面个性化**
- 🖼️ 自定义壁纸：URL 输入 / 本地图片上传 / 拖拽上传 / 预设壁纸
- 🎨 自定义 Logo：Emoji 选择 / 本地图片上传 / 自定义标题和副标题
- 🔆 页面透明度：滑块调节 (30%~100%) / 快捷预设
- 🌙 日夜主题切换
- 所有设置持久化到 localStorage

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

## 技术栈

- **后端**: Node.js（内置模块）
- **前端**: 纯 HTML/CSS/JS
