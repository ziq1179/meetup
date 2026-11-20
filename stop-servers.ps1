# Stop all servers on ports 3000, 3001, 3002, 4000

Write-Host "🛑 Stopping servers on ports 3000, 3001, 3002, 4000..." -ForegroundColor Yellow
Write-Host ""

$ports = @(3000, 3001, 3002, 4000)
$killed = 0

foreach ($port in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($connections) {
        foreach ($conn in $connections) {
            $processId = $conn.OwningProcess
            $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if ($process) {
                Write-Host "  Killing process $processId ($($process.ProcessName)) on port $port" -ForegroundColor Red
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                $killed++
            }
        }
    } else {
        Write-Host "  Port $port is free" -ForegroundColor Green
    }
}

Write-Host ""
if ($killed -gt 0) {
    Write-Host "✅ Stopped $killed process(es)" -ForegroundColor Green
} else {
    Write-Host "✅ All ports are free" -ForegroundColor Green
}

Write-Host ""
Write-Host "💡 Now you can run: npm run dev:full" -ForegroundColor Cyan
