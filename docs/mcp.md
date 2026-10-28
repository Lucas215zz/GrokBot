# MCP 接入

MCP（Model Context Protocol）让 Bot 获得外部能力：数据库、浏览器、GitHub、
各类 SaaS 等。接进来之后，这些工具和内置工具一样能被模型自主调用。

## 配置存在哪

```
%APPDATA%\Grok Bot\mcp.json
```

界面上「左栏 → 🔌 MCP」可增删、连接/断开。

## 两种传输方式

### stdio（本地进程，最常用）

```json
{
  "servers": [
    {
      "name": "filesystem",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"],
      "env": {},
      "enabled": true
    }
  ]
}
```

### http（远程端点）

```json
{
  "servers": [
    { "name": "remote", "type": "http", "url": "https://example.com/mcp" }
  ]
}
```

## 工具命名规则

MCP 工具会以 `mcp__<服务器名>__<工具名>` 的形式注入，避免和内置工具冲突：

```
mcp__filesystem__read_file
mcp__github__create_issue
mcp__calc__add_numbers
```

## 实测证据

启动一个最小 MCP 服务器（提供 `add_numbers`），让 Bot 算 1234 + 5678：

```
工具调用: mcp__calc__add_numbers
回复: 1234 + 5678 = 6912
```

模型自己判断该调这个工具，不需要额外提示。

## 按 Bot 隔离

Bot 配置里的 `enabledMcp` 数组控制可用服务器：

- 不填 = 全部 MCP 工具都可用
- 填 `["github"]` = 只有 github 的工具

## 生命周期

- 应用启动时自动连接所有 `enabled: true` 的服务器
- 连接失败会记录在 `status().error`，界面显示红点
- 应用退出时自动断开子进程

## 常见服务器

| 服务器 | 用途 | 启动命令 |
| --- | --- | --- |
| filesystem | 读写指定目录 | `npx -y @modelcontextprotocol/server-filesystem <dir>` |
| github | 仓库/Issue/PR | `npx -y @modelcontextprotocol/server-github` |
| postgres / sqlite | 数据库查询 | 见各自文档 |
| playwright | 浏览器自动化 | `npx -y @playwright/mcp` |

> 第三方服务器会以你的权限访问数据，接入前请确认来源可信。
