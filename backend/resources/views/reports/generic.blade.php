<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{{ $title }}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: DejaVu Sans, sans-serif; font-size: 10px; color: #1c1c1c; margin: 24px; }
  header { border-bottom: 2px solid #4d5d2d; padding-bottom: 8px; margin-bottom: 14px; }
  header table, header td, .signatures table, .signatures td { border: 0; padding: 0; background: none !important; }
  header .logo { width: 58px; height: 58px; }
  .brand { font-weight: 700; color: #4d5d2d; font-size: 12px; }
  .brand small { display:block; color:#444; font-weight: 400; }
  h1 { font-size: 14px; margin: 0; color: #2c2c2c; }
  .meta { color:#666; font-size: 9px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #c5c5c5; padding: 5px 6px; text-align: left; vertical-align: top; }
  th { background: #4d5d2d; color: #fff; font-weight: 600; text-transform: uppercase; font-size: 9px; letter-spacing: .03em; }
  tr:nth-child(even) td { background: #f6f7f1; }
  td.money, th.money { text-align: right; white-space: nowrap; }
  tr.total td { background: #e9ecdc !important; font-weight: 700; border-top: 2px solid #4d5d2d; }
  .signatures { margin-top: 34px; page-break-inside: avoid; }
  .signatures td { width: 50%; vertical-align: bottom; }
  .sig-line { width: 240px; border-top: 1px solid #1c1c1c; padding-top: 3px; }
  .sig-label { font-size: 9px; color: #444; text-transform: uppercase; letter-spacing: .04em; }
  .sig-name { width: 240px; text-align: center; font-weight: 700; font-size: 10px; margin-top: 26px; padding-bottom: 2px; }
  footer { margin-top: 14px; font-size: 9px; color:#666; text-align:center; border-top: 1px dashed #999; padding-top: 6px; }
</style>
</head>
<body>
  <header>
    <table>
      <tr>
        @if (!empty($logo))
          <td style="width:66px; vertical-align:middle;"><img class="logo" src="{{ $logo }}" alt="10RCDG"></td>
        @endif
        <td style="vertical-align:middle;">
          <div class="brand">
            ArmoryDB — 10RCDG
            <small>IoT-Based Firearm Accountability and Monitoring System with GPS, Geofencing, and Biometric Authentication</small>
          </div>
        </td>
        <td style="text-align:right; vertical-align:middle;">
          <h1>{{ $title }}</h1>
          <div class="meta">Generated: {{ $generatedAt }} · CONFIDENTIAL</div>
        </td>
      </tr>
    </table>
  </header>

  <table>
    <thead>
      <tr>
        @foreach ($columns as $c)
          <th class="{{ in_array($c, $money ?? []) ? 'money' : '' }}">{{ str_replace('_', ' ', $c) }}</th>
        @endforeach
      </tr>
    </thead>
    <tbody>
      @forelse ($rows as $row)
        <tr>
          @foreach ($columns as $c)
            @if (in_array($c, $money ?? []))
              <td class="money">{{ number_format((float) ($row[$c] ?? 0)) }}</td>
            @else
              <td>{{ $row[$c] ?? '' }}</td>
            @endif
          @endforeach
        </tr>
      @empty
        <tr><td colspan="{{ count($columns) }}" style="text-align:center; padding:18px;">No records.</td></tr>
      @endforelse
      @if (!empty($totals) && count($rows))
        <tr class="total">
          @foreach ($columns as $i => $c)
            @if (array_key_exists($c, $totals))
              <td class="money">PHP {{ number_format($totals[$c]) }}</td>
            @elseif ($i === 0)
              <td>TOTAL COST ({{ count($rows) }} {{ count($rows) === 1 ? 'item' : 'items' }})</td>
            @else
              <td></td>
            @endif
          @endforeach
        </tr>
      @endif
    </tbody>
  </table>

  <div class="signatures">
    <table>
      <tr>
        <td>
          <div class="sig-label">Prepared by:</div>
          <div class="sig-name">{{ $preparedBy ?? '' }}</div>
          <div class="sig-line">
            <div class="sig-label">Signature over printed name</div>
          </div>
        </td>
        <td>
          <div class="sig-label">Received by:</div>
          <div class="sig-name">&nbsp;</div>
          <div class="sig-line">
            <div class="sig-label">Signature over printed name / Date</div>
          </div>
        </td>
      </tr>
    </table>
  </div>

  <footer>
    Property of the 10th Regional Community Defense Group, Reserve Command, Philippine Army.
    For internal use only — Do not redistribute.
  </footer>
</body>
</html>
