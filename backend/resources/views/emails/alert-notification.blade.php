<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1f16; color: #e8e8e0; padding: 32px; }
        .container { max-width: 560px; margin: 0 auto; background: #252b1f; border-radius: 12px; padding: 32px; border: 1px solid #3d4a2f; }
        .header { text-align: center; margin-bottom: 24px; }
        .header h1 { font-size: 18px; color: #aeb771; margin: 0; letter-spacing: 2px; text-transform: uppercase; }
        .severity { display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
        .severity-critical { background: #7f1d1d; color: #fca5a5; }
        .severity-warning { background: #78350f; color: #fcd34d; }
        .severity-info { background: #1e3a5f; color: #93c5fd; }
        .title { font-size: 20px; font-weight: bold; color: #f0f0e8; margin: 16px 0 8px; }
        .message { color: #b8b8a8; line-height: 1.6; }
        .meta { margin-top: 20px; padding-top: 16px; border-top: 1px solid #3d4a2f; font-size: 12px; color: #888; }
        .footer { text-align: center; margin-top: 24px; font-size: 11px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>ArmoryDB · 10th RCDG</h1>
        </div>

        <span class="severity severity-{{ $notification->severity }}">
            {{ strtoupper($notification->severity) }}
        </span>

        <h2 class="title">{{ $notification->title }}</h2>
        <p class="message">{{ $notification->message }}</p>

        <div class="meta">
            <p><strong>Type:</strong> {{ $notification->type }}</p>
            <p><strong>Time:</strong> {{ $notification->created_at->format('Y-m-d H:i:s') }} UTC</p>
            @if($notification->equipment_id)
                <p><strong>Equipment ID:</strong> #{{ $notification->equipment_id }}</p>
            @endif
        </div>

        <div class="footer">
            <p>This is an automated alert from ArmoryDB, the IoT-Based Firearm Accountability and Monitoring System.</p>
            <p>Do not reply to this email. Log in to the dashboard for details.</p>
        </div>
    </div>
</body>
</html>
