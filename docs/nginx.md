# Nginx 反向代理配置

如果在生产环境中使用 Nginx 作为反向代理，请使用以下配置以确保 **Server-Sent Events (SSE)** 正常工作。

## 为什么 SSE 需要特殊配置？

SSE (Server-Sent Events) 是一种长连接、流式传输技术，与普通 HTTP 请求有本质区别：

| Nginx 默认行为 | 对 SSE 的影响 | 问题 |
|---------------|--------------|------|
| `proxy_buffering on` | 缓冲响应数据 | 数据被缓冲，无法实时推送 |
| `proxy_http_version 1.0` | 使用 HTTP/1.0 | 不支持长连接，每次响应后关闭 |
| `Connection: close` | 关闭连接头 | SSE 需要保持连接打开 |
| 短超时（60秒） | 60秒后断开 | SSE 可能需要保持数小时 |

**不配置 SSE 专用规则会导致**：
- 实时更新变成"批量更新"或超时
- 连接频繁断开，前端报 `net::ERR_FAILED`
- 缩略图生成进度无法实时显示

## HTTP 代理配置（仅用于开发/测试）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 0; # 允许上传大文件

    # ⚠️ 重要：SSE 专用配置必须放在通用 location 之前
    location /api/events {
        proxy_pass http://127.0.0.1:12080/api/events;
        
        # SSE 关键配置
        proxy_http_version 1.1;
        proxy_set_header Connection '';  # 清空连接头，保持长连接
        
        # 禁用所有缓冲，确保实时传输
        proxy_buffering off;
        proxy_cache off;
        
        # 长超时配置（24小时）
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        
        # 支持分块传输
        chunked_transfer_encoding on;
        
        # TCP 优化
        tcp_nodelay on;
        tcp_nopush on;
        
        # 标准代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 通用代理配置
    location / {
        proxy_pass http://127.0.0.1:12080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## HTTPS 代理配置（生产环境推荐）

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL 证书配置
    ssl_certificate /path/to/your/fullchain.pem;
    ssl_certificate_key /path/to/your/private.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    client_max_body_size 0;

    # ⚠️ 重要：SSE 专用配置必须放在通用 location 之前
    location /api/events {
        proxy_pass http://127.0.0.1:12080/api/events;
        
        # SSE 关键配置
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        
        # 禁用缓冲
        proxy_buffering off;
        proxy_cache off;
        
        # 长超时（24小时）
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        
        # 流式传输优化
        chunked_transfer_encoding on;
        tcp_nodelay on;
        tcp_nopush on;
        
        # 标准代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 通用代理配置
    location / {
        proxy_pass http://127.0.0.1:12080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# HTTP 自动跳转到 HTTPS
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

## 验证 SSE 配置

**方法 1：浏览器控制台测试**
```javascript
const es = new EventSource('https://your-domain.com/api/events');
es.onopen = () => console.log('✅ SSE 连接成功！');
es.onerror = (e) => console.error('❌ SSE 连接失败：', e);
es.addEventListener('connected', (e) => console.log('📨 收到connected事件：', e.data));
```

**方法 2：命令行测试**
```bash
# 测试 HTTP
curl -N -H "Accept: text/event-stream" http://your-domain.com/api/events

# 测试 HTTPS
curl -N -H "Accept: text/event-stream" https://your-domain.com/api/events
```

预期输出：
```
event: connected
data: {"message":"SSE connection established.","clientId":"..."}

: keep-alive

: keep-alive
```

**方法 3：查看 Network 标签**
1. 打开浏览器开发者工具（F12）
2. 切换到 **Network** 标签
3. 筛选 **EventStream** 类型
4. 查找 `/api/events` 请求
5. 状态应该是 **200** 且持续保持连接

---

##  avançado 进阶：负载均衡与多节点
如果在多台服务器间运行负载均衡：

1. **会话持久性 (Session Persistence)**：必须启用 `ip_hash`，确保同一个客户端的 SSE 连接始终指向同一个后端实例。
2. **Redis 状态共享**：所有后端节点必须连接到同一个 Redis 资源，以同步任务进度。

```nginx
upstream photonix_cluster {
    ip_hash;
    server 192.168.1.10:12080;
    server 192.168.1.11:12080;
}
```

## 🔐 故障排除：Cloudflare/CDN 特定设置
如果您通过 Cloudflare 或类似 CDN 访问：
- **Buffering**: 必须在 Cloudflare 仪表板中禁用响应缓冲，或通过 `X-Accel-Buffering: no` 响应头告知。
- **Timeout**: CDN 通常有 100 秒的空闲超时。Photonix 已经内置了 `: keep-alive` 心跳包来防止连接断开。

---

## 常见问题排查

| 现象 | 可能原因 | 解决方案 |
|------|---------|---------|
| 连接立即断开 | 缺少 `proxy_http_version 1.1` 或 `Connection ''` | 添加 SSE 专用配置 |
| 数据延迟数秒才到达 | `proxy_buffering on` 未禁用 | 设置 `proxy_buffering off` |
| 60秒后自动断开 | 超时配置过短 | 增加 `proxy_read_timeout` 到 24小时 |
| `net::ERR_FAILED` | Nginx 配置未生效 | 执行 `nginx -t && nginx -s reload` |
| HTTPS 下无法连接 | 后端使用 HTTP，需要协议转换 | 使用 `proxy_pass http://...` 即可 |
