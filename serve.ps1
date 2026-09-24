# Serves LectureListen at http://localhost:8000 (no installs needed).
# Usage:  powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8000]
param([int]$Port = 8000)

$root = $PSScriptRoot
$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
  '.json' = 'application/json'
  '.md'   = 'text/markdown; charset=utf-8'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "LectureListen running at http://localhost:$Port/  (Ctrl+C to stop)"

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $response = $context.Response
    try {
      $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath).TrimStart('/')
      if (-not $path) { $path = 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path))

      if ($file.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $file -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $ext = [IO.Path]::GetExtension($file).ToLower()
        $response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
        $response.Headers.Add('Cache-Control', 'no-cache')
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $response.StatusCode = 404
      }
    } finally {
      $response.Close()
    }
  }
} finally {
  $listener.Stop()
}
