$ErrorActionPreference = 'Stop'
$docPath = Join-Path $PSScriptRoot '../../deliverables/Bao_cao_du_an_QuanLyPharmacy_GPP.docx'
$pdfPath = Join-Path $PSScriptRoot 'report.pdf'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $document = $word.Documents.Open([System.IO.Path]::GetFullPath($docPath), $false, $true)
  $document.ExportAsFixedFormat($pdfPath, 17)
  Write-Output "Pages: $($document.ComputeStatistics(2))"
  $document.Close(0)
} finally {
  $word.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
