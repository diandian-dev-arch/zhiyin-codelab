$root = 'C:\Users\Jie\Documents\ChatGPT\competition'
$items = @()
foreach ($p in @('.env', '.env.local', '.env.example')) {
  $f = Join-Path $root $p
  if (Test-Path $f) { $items += [pscustomobject]@{path=$p;size=(Get-Item $f).Length;sha256=(Get-FileHash $f -Algorithm SHA256).Hash.ToLower();sensitive=($p -ne '.env.example');usage_phase='runtime';upload_mode='package'} }
}
$body=[ordered]@{suggested_name='知因 CodeLab';agent_label='Codex';client_ide='codex';client_llm='openai';config_files=$items;product_candidates=@();database_facts=[ordered]@{kind='postgres';engine='postgresql';evidence=@('apps/api/src/db.ts','deploy/compose.yaml','.data/workspace-database.json')}}|ConvertTo-Json -Depth 8
$credPath=Join-Path $env:USERPROFILE '.pocketbay\credentials.json';$c=Get-Content $credPath -Raw|ConvertFrom-Json;$tok=$c.'https://pocketbay.com'._device.token
$s=Invoke-RestMethod -Uri 'https://pocketbay.com/api/deploy/sessions' -Method Post -Headers @{Authorization="Bearer $tok"} -ContentType 'application/json' -Body $body
Write-Output ('PAIRING_URL='+$s.pairing_url);$secret=$s.device_secret
while($true){$w=Invoke-RestMethod -Uri 'https://pocketbay.com/api/deploy/sessions/wait?timeout=15' -Headers @{Authorization="Bearer $secret"};Write-Output (([ordered]@{status=$w.status;action_required=$w.action_required;project_status=$w.project_status;project_slug=$w.project_slug;approved_config_paths=$w.approved_config_paths;database_choice=$w.database_choice}|ConvertTo-Json -Compress));if($w.status -eq 'authorized'){break};if($w.status -in @('denied','expired')){exit 2}}
$approved=@($w.approved_config_paths);$stage=Join-Path $env:TEMP ('codelab-pocketbay-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $stage|Out-Null
$null=robocopy $root $stage /E /XD .git node_modules .data dist build out .cache test-output test-results tmp /XF .env .env.local '*.log' '*.sql' '*.dump' '*.pem' '*.key' '*.crt'|Out-Null
foreach($p in $approved){$src=Join-Path $root $p;if(Test-Path $src){$dst=Join-Path $stage $p;New-Item -ItemType Directory -Path (Split-Path $dst) -Force|Out-Null;Copy-Item $src $dst -Force}}
$zip=Join-Path $env:TEMP 'zhiyin-codelab-pocketbay.zip';if(Test-Path $zip){Remove-Item $zip -Force};Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal;Write-Output ('PACKAGE_BYTES='+(Get-Item $zip).Length)
$up=Invoke-WebRequest -Uri 'https://pocketbay.com/api/deploy/sessions/upload' -Method Post -Headers @{Authorization="Bearer $secret"} -Form @{file=Get-Item $zip};Write-Output ('UPLOAD_HTTP='+$up.StatusCode)
while($true){Start-Sleep -Seconds 5;$st=Invoke-RestMethod -Uri 'https://pocketbay.com/api/deploy/sessions/status' -Headers @{Authorization="Bearer $secret"};Write-Output (([ordered]@{next_action=$st.next_action;project_status=$st.project_status;url=$st.url;console_url=$st.console_url;error_category=$st.error_category;repair_hint=$st.repair_hint;active_release_unchanged=$st.versioning.active_release_unchanged}|ConvertTo-Json -Compress));if($st.project_status -in @('running','failed','error','stopped')){break}}
