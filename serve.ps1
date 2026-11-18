# Fusion720 — tiny static file server (no Node or Python needed).
# Usage:  powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8720] [-Root <folder>]
param([int]$Port = 8720, [string]$Root = '')

$root = if ($Root) { $Root } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = [IO.Path]::GetFullPath($root).TrimEnd('\')
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Fusion720 running at http://localhost:$Port/  (Ctrl+C to stop)"

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.svg' = 'image/svg+xml'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.ico' = 'image/x-icon'; '.wasm' = 'application/wasm'
  '.md' = 'text/markdown; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'; '.woff2' = 'font/woff2'
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
      $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
      if ($full -ne $root -and -not $full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) { $res.StatusCode = 403; $res.Close(); continue }
      if (Test-Path $full -PathType Container) { $full = Join-Path $full 'index.html' }
      if (Test-Path $full -PathType Leaf) {
        $ext = [IO.Path]::GetExtension($full).ToLower()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-cache')
        $bytes = [IO.File]::ReadAllBytes($full)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $res.StatusCode = 404
        $msg = [Text.Encoding]::UTF8.GetBytes("Not found: $rel")
        $res.OutputStream.Write($msg, 0, $msg.Length)
      }
    } catch {
      try { $res.StatusCode = 500 } catch {}
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
