#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PromptFile,
    [Parameter(Mandatory)][string]$OutputFile,
    [string[]]$ReferenceImages = @(),
    [string]$Model = 'gpt-6.1-sol',
    [string]$CodexPath,
    [string]$JobDirectory,
    [ValidateRange(30, 3600)][int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
$jobRoot = $null
$process = $null
try {
    $codexExe = if ($CodexPath) {
        (Resolve-Path -LiteralPath $CodexPath).Path
    } else {
        (Get-Command codex -CommandType Application -ErrorAction Stop).Source
    }
    $promptPath = (Resolve-Path -LiteralPath $PromptFile).Path
    $targetPath = [IO.Path]::GetFullPath($OutputFile)
    if ([IO.Path]::GetExtension($targetPath) -ne '.png') { throw 'OutputFile must end in .png.' }
    if (Test-Path -LiteralPath $targetPath) { throw 'OutputFile already exists. Choose a new filename.' }
    if ($ReferenceImages.Count -gt 5) { throw 'This sample supports at most five attached reference images.' }
    $referencePaths = @($ReferenceImages | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
    if (-not $JobDirectory) {
        $JobDirectory = Join-Path (Get-Location) ('work/codex-image-jobs/' + [guid]::NewGuid().ToString('N'))
    }
    $jobRoot = [IO.Path]::GetFullPath($JobDirectory)
    if (Test-Path -LiteralPath $jobRoot) { throw 'JobDirectory already exists. Each invocation needs a new directory.' }
    New-Item -ItemType Directory -Path $jobRoot | Out-Null
    $schemaPath = Join-Path $jobRoot 'result.schema.json'
    $resultPath = Join-Path $jobRoot 'codex-result.json'
    $eventsPath = Join-Path $jobRoot 'events.jsonl'
    $stderrPath = Join-Path $jobRoot 'stderr.log'
    $utf8 = [Text.UTF8Encoding]::new($false)
    $schema = @'
{"type":"object","properties":{"status":{"type":"string","enum":["generated","failed","unavailable"]},"tool_used":{"type":"boolean"},"images":{"type":"array","items":{"type":"string"}},"prompt_used":{"type":"string"},"error":{"type":["string","null"]}},"required":["status","tool_used","images","prompt_used","error"],"additionalProperties":false}
'@
    [IO.File]::WriteAllText($schemaPath, $schema, $utf8)
    $taskPrompt = @'
$imagegen
Generate or edit exactly ONE image according to the task below. Any attached images are explicitly numbered in attachment order; use the task's stated roles and invariants.
Use only the built-in image_gen tool with saved ChatGPT authentication. Do not use an API, the image_gen.py fallback, a browser, another service, or a programmatic replacement image. Do not delegate. Do not read credential files. Make at most one generation call. If the tool is unavailable or fails, report that failure without switching backend or retrying.
Let the built-in tool save the original raster image in its normal generated_images directory. Do not copy, rename, or process files inside this Codex run. Return JSON matching the supplied schema. On success: status generated, tool_used true, images containing the exact saved PNG path, prompt_used containing the actual image prompt, error null. Use forward slashes in paths. On failure: images [], tool_used reflecting what happened, and the actual error.

TASK:
'@
    $taskPrompt += "`n" + [IO.File]::ReadAllText($promptPath, [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText((Join-Path $jobRoot 'prompt.txt'), $taskPrompt, $utf8)
    $arguments = @(
        'exec', '--ignore-user-config', '--enable', 'image_generation', '--disable', 'multi_agent',
        '--skip-git-repo-check', '--sandbox', 'read-only', '-m', $Model,
        '-c', 'forced_login_method="chatgpt"', '-c', 'model_reasoning_effort="medium"',
        '-C', $jobRoot, '--json', '--output-schema', $schemaPath, '-o', $resultPath, '-'
    )
    foreach ($referencePath in $referencePaths) { $arguments += @('-i', $referencePath) }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $codexExe
    $startInfo.WorkingDirectory = $jobRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardInputEncoding = $utf8
    $startInfo.StandardOutputEncoding = $utf8
    $startInfo.StandardErrorEncoding = $utf8
    foreach ($argument in $arguments) { $startInfo.ArgumentList.Add($argument) }
    # These removals affect this child only; the caller's environment is unchanged.
    foreach ($keyName in @('OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN')) {
        [void]$startInfo.Environment.Remove($keyName)
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($taskPrompt)
    $process.StandardInput.Close()
    $finished = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $finished) { $process.Kill($true); $process.WaitForExit() }
    [IO.File]::WriteAllText($eventsPath, $stdoutTask.GetAwaiter().GetResult(), $utf8)
    [IO.File]::WriteAllText($stderrPath, $stderrTask.GetAwaiter().GetResult(), $utf8)
    if (-not $finished) { throw 'Codex timed out. Inspect logs and saved outputs before retrying; generation may already have occurred.' }
    if ($process.ExitCode -ne 0) { throw "Codex exited with code $($process.ExitCode). See stderr.log." }
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) { throw 'Codex did not return a result manifest.' }
    $result = [IO.File]::ReadAllText($resultPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($result.status -ne 'generated' -or $result.tool_used -ne $true -or $result.error) {
        throw "Codex reported $($result.status): $($result.error)"
    }
    if (@($result.images).Count -ne 1) { throw 'Expected exactly one generated image path.' }
    $sourcePath = [IO.Path]::GetFullPath([string]$result.images[0])
    $codexStateRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $generatedRoot = [IO.Path]::GetFullPath((Join-Path $codexStateRoot 'generated_images')).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    if (-not $sourcePath.StartsWith($generatedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Returned file is outside the expected Codex generated_images directory.'
    }
    $bytes = [IO.File]::ReadAllBytes($sourcePath)
    $pngSignature = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
    if ($bytes.Length -lt 33) { throw 'Generated image is empty or truncated.' }
    for ($index = 0; $index -lt 8; $index++) {
        if ($bytes[$index] -ne $pngSignature[$index]) { throw 'Generated file is not a PNG.' }
    }
    $width = ([uint32]$bytes[16] -shl 24) -bor ([uint32]$bytes[17] -shl 16) -bor ([uint32]$bytes[18] -shl 8) -bor [uint32]$bytes[19]
    $height = ([uint32]$bytes[20] -shl 24) -bor ([uint32]$bytes[21] -shl 16) -bor ([uint32]$bytes[22] -shl 8) -bor [uint32]$bytes[23]
    if ($width -lt 1 -or $height -lt 1) { throw 'Generated PNG has invalid dimensions.' }
    $targetParent = [IO.Path]::GetDirectoryName($targetPath)
    [IO.Directory]::CreateDirectory($targetParent) | Out-Null
    [IO.File]::Copy($sourcePath, $targetPath, $false)
    $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) { throw 'Copied image failed the integrity check.' }
    $summary = [ordered]@{
        status = 'success'; backend = 'codex_builtin'; output_file = $targetPath;
        source_file = $sourcePath; width = $width; height = $height;
        byte_length = $bytes.Length; sha256 = $targetHash;
        prompt_used = $result.prompt_used; job_directory = $jobRoot
    }
    $summaryJson = $summary | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText((Join-Path $jobRoot 'result.json'), $summaryJson, $utf8)
    Write-Output $summaryJson
    exit 0
}
catch {
    $failure = [ordered]@{ status = 'failed'; error = $_.Exception.Message; job_directory = $jobRoot }
    $failureJson = $failure | ConvertTo-Json -Depth 5
    if ($jobRoot -and (Test-Path -LiteralPath $jobRoot -PathType Container)) {
        [IO.File]::WriteAllText((Join-Path $jobRoot 'result.json'), $failureJson, [Text.UTF8Encoding]::new($false))
    }
    Write-Output $failureJson
    exit 1
}
finally {
    if ($process) { $process.Dispose() }
}
