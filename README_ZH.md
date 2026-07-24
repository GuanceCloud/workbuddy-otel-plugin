# workbuddy-otel-plugin

`workbuddy-otel-plugin` 将 WorkBuddy 原生会话导出为符合 [Guance gtrace AI 语义约定](https://github.com/GuanceCloud/guance-gtrace-ai-semantic-conventions) 的 OpenTelemetry Trace 与 Metrics。

首个明确支持版本为 WorkBuddy 5.2.6，支持 macOS（Apple Silicon/Intel）和 Windows x64。插件不修改 WorkBuddy 本体，不依赖外部 npm 包，也不导出 OTEL Logs。

## 能力

- 每个完整 turn 生成一个 `invoke_agent` Trace。
- 生成 `llm`、`assistant`、`tool:<name>` 和高置信度 `skill:<name>` Span。
- 主智能体与专家/子智能体分别生成 Trace，并保留可获得的父会话和父工具调用属性。
- 从同批 Span 派生四项 gtrace Metrics。
- 使用 OTLP/HTTP Protobuf，支持 Guance OpenWay 和标准 OTLP Receiver。
- 默认采集提示词、回复和工具内容，提供截断、常见秘密脱敏和完全关闭正文采集的配置。
- 重复 Stop、并发 Hook 和 Trace 成功但 Metrics 失败的场景不会重复上传已成功的信号。

## 快速安装

macOS/Linux 推荐使用远程安装器：

```bash
curl -fsSL https://github.com/GuanceCloud/workbuddy-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest \
      --endpoint https://llm-openway.guance.com \
      --x-token '<client-token>' \
      --tag 'agent_id=workbuddy-prod' \
      --tag 'agent_name=WorkBuddy'
```

Windows PowerShell：

```powershell
$installer = Join-Path $env:TEMP "workbuddy-otel-install.ps1"
Invoke-WebRequest https://github.com/GuanceCloud/workbuddy-otel-plugin/releases/latest/download/install-release.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `
  "& '$installer' -Version latest -Endpoint https://llm-openway.guance.com -XToken '<client-token>' -Tag @('agent_id=workbuddy-prod','agent_name=WorkBuddy')"
```

本地解压安装仍可运行 `bash scripts/install.sh ...` 或 `.\scripts\install.ps1 ...`。安装器会创建本地 `guance` marketplace、启用 `workbuddy-otel-plugin@guance`、合并现有设置，并创建或增量更新 `gtrace.json`。普通升级保留已有 endpoint、Token、路径、启停和隐私配置。安装后重启 WorkBuddy 或运行 `/reload-plugins`。

也可以在 WorkBuddy 中执行以下命令，把仓库内的 `marketplace/` 目录作为本地 marketplace 添加后安装插件：

```text
/plugin marketplace add /path/to/workbuddy-otel-plugin/marketplace
/plugin install workbuddy-otel-plugin@guance
```

这种方式会使用 `userConfig`，将 `x_token` 交给 WorkBuddy 的敏感凭据存储。

## 配置

默认配置：

```json
{
  "enabled": true,
  "endpoint": "https://llm-openway.guance.com",
  "tracePath": "v1/write/otel-llm",
  "metricsPath": "v1/write/otel-metrics",
  "capture_content": true,
  "max_chars": 20000,
  "timeout_ms": 25000
}
```

配置优先级：WorkBuddy 插件选项 > 标准 OTEL 环境变量 > `~/.workbuddy/gtrace.json` > 默认值。完整字段见 [配置文档](docs/configuration.md)。

## 验证

```bash
npm test
npm run check
npm ls --all
```

详细文档：

- [安装、升级与卸载](docs/install.md)
- [Trace 字段与层级](docs/traces.md)
- [Metrics](docs/metrics.md)
- [隐私与数据采集](docs/privacy.md)
- [开发与故障排查](docs/development.md)

英文说明见 [README.md](README.md)。
