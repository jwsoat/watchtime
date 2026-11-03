package nz.jwsoat.watchtime;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Config screen: server + key, special-access prompts, the tracked-app picker and
 * the start/stop switch for the background watcher.
 */
public class MainActivity extends Activity {

    private EditText urlField;
    private EditText keyField;
    private EditText mediaUserField;
    private Switch enableSwitch;
    private TextView statusView;
    private TextView clientView;
    private LinearLayout appList;
    private Button usageButton;
    private Button batteryButton;
    private Button notifButton;
    private Button mediaButton;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable statusTick = new Runnable() {
        @Override
        public void run() {
            refreshStatus();
            ui.postDelayed(this, 2000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildUi());
        loadSettings();
        applyProvisioningIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        applyProvisioningIntent(intent);
    }

    /**
     * Lets a device be provisioned from adb without touching the UI:
     * {@code adb shell am start -n nz.jwsoat.watchtime/.MainActivity \
     *   -e base_url http://10.0.2.2:8767 -e api_key XXX \
     *   -e track com.tiktok,com.netflix.mediaclient -e autostart true}
     */
    private void applyProvisioningIntent(Intent intent) {
        if (intent == null) return;
        boolean changed = false;

        String url = intent.getStringExtra("base_url");
        if (url != null && !url.trim().isEmpty()) {
            Config.setBaseUrl(this, url);
            urlField.setText(Config.baseUrl(this));
            changed = true;
        }
        String key = intent.getStringExtra("api_key");
        if (key != null && !key.trim().isEmpty()) {
            Config.setApiKey(this, key);
            keyField.setText(Config.apiKey(this));
            changed = true;
        }
        String track = intent.getStringExtra("track");
        if (track != null) {
            Set<String> set = new HashSet<>();
            for (String p : track.split(",")) {
                String t = p.trim();
                if (!t.isEmpty()) set.add(t);
            }
            Config.setTracked(this, set);
            populateApps();
            changed = true;
        }
        intent.removeExtra("base_url");
        intent.removeExtra("api_key");
        intent.removeExtra("track");

        boolean autostart = "true".equalsIgnoreCase(intent.getStringExtra("autostart"));
        intent.removeExtra("autostart");
        if (changed) Config.setLastStatus(this, "Provisioned from intent");
        if (autostart) {
            enableSwitch.setChecked(true);
            startWatcher();
        }
        refreshStatus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        ui.post(statusTick);
    }

    @Override
    protected void onPause() {
        super.onPause();
        ui.removeCallbacks(statusTick);
        saveSettings(false);
    }

    // ---------------------------------------------------------------- UI build

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setFitsSystemWindows(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(18);
        root.setPadding(pad, pad, pad, pad);
        scroll.addView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText("Watchtime Agent");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("Sends a heartbeat to watchtime every 10s while a tracked app is in the "
                + "foreground, tagged platform \u201cmobile-android\u201d. Replaces the Tasker profiles.");
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        sub.setPadding(0, dp(6), 0, dp(14));
        root.addView(sub);

        root.addView(label("Server URL"));
        urlField = new EditText(this);
        urlField.setSingleLine(true);
        urlField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlField.setHint(Config.DEFAULT_BASE_URL);
        root.addView(urlField);

        root.addView(label("API key"));
        keyField = new EditText(this);
        keyField.setSingleLine(true);
        keyField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        keyField.setHint("X-API-Key value");
        root.addView(keyField);

        root.addView(label("Watching as (account name)"));
        mediaUserField = new EditText(this);
        mediaUserField.setSingleLine(true);
        mediaUserField.setInputType(InputType.TYPE_CLASS_TEXT);
        mediaUserField.setHint("Who the watch time is attributed to — blank = unattributed");
        root.addView(mediaUserField);

        clientView = new TextView(this);
        clientView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        clientView.setPadding(0, dp(6), 0, dp(10));
        root.addView(clientView);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setPadding(0, 0, 0, dp(12));
        Button save = button("Save");
        save.setOnClickListener(v -> {
            saveSettings(true);
            Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
        });
        Button test = button("Test beat");
        test.setOnClickListener(v -> sendTestBeat());
        buttons.addView(save, weight());
        buttons.addView(test, weight());
        root.addView(buttons);

        root.addView(sectionHeader("Permissions"));
        usageButton = button("Usage access");
        usageButton.setOnClickListener(v -> openUsageAccess());
        root.addView(usageButton);
        batteryButton = button("Battery optimisation");
        batteryButton.setOnClickListener(v -> openBatterySettings());
        root.addView(batteryButton);
        notifButton = button("Notification permission");
        notifButton.setOnClickListener(v -> requestNotifications());
        root.addView(notifButton);
        mediaButton = button("Notification access (media titles)");
        mediaButton.setOnClickListener(v -> openNotificationAccess());
        root.addView(mediaButton);

        root.addView(sectionHeader("Tracking"));
        enableSwitch = new Switch(this);
        enableSwitch.setText("Run in background");
        enableSwitch.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        enableSwitch.setPadding(0, dp(8), 0, dp(8));
        enableSwitch.setOnCheckedChangeListener((CompoundButton bv, boolean checked) -> {
            if (checked) startWatcher(); else stopWatcher();
        });
        root.addView(enableSwitch);

        statusView = new TextView(this);
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        statusView.setPadding(0, dp(4), 0, dp(14));
        root.addView(statusView);

        LinearLayout appsHeader = new LinearLayout(this);
        appsHeader.setOrientation(LinearLayout.HORIZONTAL);
        appsHeader.setPadding(0, dp(16), 0, dp(4));
        TextView appsTitle = new TextView(this);
        appsTitle.setText("Tracked apps");
        appsTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        appsTitle.setTypeface(appsTitle.getTypeface(), android.graphics.Typeface.BOLD);
        appsHeader.addView(appsTitle, weight());
        Button refresh = button("Refresh");
        refresh.setOnClickListener(v -> populateApps());
        appsHeader.addView(refresh);
        root.addView(appsHeader);

        TextView appsHint = new TextView(this);
        appsHint.setText("Tick every app whose watch time should count (TikTok, Twitch, Netflix, "
                + "YouTube…). Channel = app name, same as the Tasker build.");
        appsHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        appsHint.setPadding(0, 0, 0, dp(8));
        root.addView(appsHint);

        appList = new LinearLayout(this);
        appList.setOrientation(LinearLayout.VERTICAL);
        root.addView(appList);

        return scroll;
    }

    private TextView label(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        tv.setPadding(0, dp(10), 0, 0);
        return tv;
    }

    private TextView sectionHeader(String text) {
        TextView tv = label(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        tv.setTypeface(tv.getTypeface(), android.graphics.Typeface.BOLD);
        tv.setPadding(0, dp(20), 0, dp(4));
        return tv;
    }

    private Button button(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        return b;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.setMargins(dp(4), 0, dp(4), 0);
        return lp;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    // ------------------------------------------------------------- settings

    private void loadSettings() {
        urlField.setText(Config.baseUrl(this));
        keyField.setText(Config.apiKey(this));
        mediaUserField.setText(Config.mediaUser(this));
        clientView.setText("client_id: " + Config.clientId(this));
        enableSwitch.setChecked(Config.enabled(this) && HeartbeatService.running);
        populateApps();
        refreshStatus();
    }

    private void saveSettings(boolean explicit) {
        Config.setBaseUrl(this, urlField.getText().toString());
        Config.setApiKey(this, keyField.getText().toString());
        Config.setMediaUser(this, mediaUserField.getText().toString());
        if (explicit) {
            setTitle("Watchtime Agent");
        }
    }

    private void populateApps() {
        appList.removeAllViews();
        PackageManager pm = getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN, null);
        main.addCategory(Intent.CATEGORY_LAUNCHER);

        Map<String, String> apps = new LinkedHashMap<>();
        List<ResolveInfo> resolved = pm.queryIntentActivities(main, 0);
        for (ResolveInfo ri : resolved) {
            if (ri.activityInfo == null) continue;
            String pkg = ri.activityInfo.packageName;
            if (getPackageName().equals(pkg)) continue;
            if (apps.containsKey(pkg)) continue;
            CharSequence lbl;
            try {
                ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                lbl = pm.getApplicationLabel(ai);
            } catch (Throwable t) {
                lbl = pkg;
            }
            apps.put(pkg, lbl == null ? pkg : lbl.toString());
        }

        List<Map.Entry<String, String>> entries = new ArrayList<>(apps.entrySet());
        Collections.sort(entries, new Comparator<Map.Entry<String, String>>() {
            @Override
            public int compare(Map.Entry<String, String> a, Map.Entry<String, String> b) {
                return a.getValue().compareToIgnoreCase(b.getValue());
            }
        });

        Set<String> tracked = new HashSet<>(Config.tracked(this));
        for (Map.Entry<String, String> e : entries) {
            final String pkg = e.getKey();
            CheckBox cb = new CheckBox(this);
            cb.setText(e.getValue() + "\n" + pkg);
            cb.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            cb.setChecked(tracked.contains(pkg));
            cb.setOnCheckedChangeListener((bv, checked) -> Config.setTracked(this, pkg, checked));
            appList.addView(cb);
        }

        if (entries.isEmpty()) {
            TextView none = new TextView(this);
            none.setText("No launchable apps found.");
            appList.addView(none);
        }
    }

    // --------------------------------------------------------------- actions

    private void startWatcher() {
        saveSettings(true);
        if (!Watcher.hasUsageAccess(this)) {
            Toast.makeText(this, "Grant usage access first", Toast.LENGTH_LONG).show();
            openUsageAccess();
            enableSwitch.setChecked(false);
            return;
        }
        if (Config.apiKey(this).isEmpty()) {
            Toast.makeText(this, "Enter your API key first", Toast.LENGTH_LONG).show();
            enableSwitch.setChecked(false);
            return;
        }
        Config.setEnabled(this, true);
        BootReceiver.scheduleSelfCheck(this);
        try {
            Intent svc = new Intent(this, HeartbeatService.class);
            svc.setAction(HeartbeatService.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc); else startService(svc);
            Toast.makeText(this, "Watcher started", Toast.LENGTH_SHORT).show();
        } catch (Throwable t) {
            Toast.makeText(this, "Could not start: " + t.getClass().getSimpleName(), Toast.LENGTH_LONG).show();
        }
        refreshStatus();
    }

    private void stopWatcher() {
        Config.setEnabled(this, false);
        BootReceiver.cancelSelfCheck(this);
        try {
            Intent svc = new Intent(this, HeartbeatService.class);
            svc.setAction(HeartbeatService.ACTION_STOP);
            startService(svc);
        } catch (Throwable ignored) {
        }
        stopService(new Intent(this, HeartbeatService.class));
        refreshStatus();
    }

    private void sendTestBeat() {
        saveSettings(true);
        final String channel = firstTrackedLabel();
        Toast.makeText(this, "Sending…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            String beat = Heartbeat.beat(System.currentTimeMillis() / 1000L,
                    channel, null, "active", true, Config.clientId(MainActivity.this), channel,
                    Config.mediaUser(MainActivity.this));
            Uplink.Result r = Uplink.send(MainActivity.this, beat);
            final String msg = r.ok
                    ? "Test beat delivered (HTTP " + r.code + ") for " + channel
                    : "Failed: " + r;
            runOnUiThread(() -> {
                Config.setLastStatus(MainActivity.this, msg);
                refreshStatus();
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
            });
        }).start();
    }

    private String firstTrackedLabel() {
        Set<String> tracked = Config.tracked(this);
        if (tracked.isEmpty()) return "Test app";
        String pkg = tracked.iterator().next();
        return Watcher.label(this, pkg);
    }

    private void refreshStatus() {
        boolean access = Watcher.hasUsageAccess(this);
        usageButton.setText(access ? "Usage access: granted ✓" : "Usage access: NOT granted — tap to fix");
        usageButton.setEnabled(!access);

        boolean notif = Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        notifButton.setText(notif ? "Notifications: granted ✓" : "Notifications: blocked — tap to allow");
        notifButton.setEnabled(!notif);

        String listeners = Settings.Secure.getString(
                getContentResolver(), "enabled_notification_listeners");
        boolean media = listeners != null && listeners.contains(getPackageName());
        mediaButton.setText(media
                ? "Notification access: granted ✓ (media titles on)"
                : "Notification access: OFF — tap to allow (enables video titles)");
        mediaButton.setEnabled(!media);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        batteryButton.setText(ignoring
                ? "Battery optimisation: off ✓"
                : "Battery optimisation: ON — tap to exempt");
        batteryButton.setEnabled(!ignoring);

        StringBuilder sb = new StringBuilder();
        sb.append(HeartbeatService.running ? "Service: running" : "Service: stopped");
        sb.append(" · beats sent: ").append(Config.beatsSent(this));
        sb.append(" · queued: ").append(Uplink.queueSize(this));
        long last = Config.lastBeatAt(this);
        if (last > 0) {
            sb.append("\nLast beat: ")
              .append(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM)
                      .format(new Date(last)));
        }
        sb.append("\n").append(Config.lastStatus(this));
        statusView.setText(sb.toString());

        boolean on = Config.enabled(this);
        if (enableSwitch.isChecked() != on) enableSwitch.setChecked(on);
    }

    // ------------------------------------------------------------ permissions

    private void openUsageAccess() {
        try {
            Intent i = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Throwable t) {
            try {
                startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS));
            } catch (Throwable t2) {
                Toast.makeText(this, "Open Settings > Special access > Usage access", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void openBatterySettings() {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Throwable t) {
            try {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Throwable t2) {
                Toast.makeText(this, "Open Settings > Battery > Unrestricted", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7);
        } else {
            Toast.makeText(this, "Notifications are allowed on this Android version", Toast.LENGTH_SHORT).show();
        }
    }

    private void openNotificationAccess() {
        try {
            startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
        } catch (Throwable t) {
            Toast.makeText(this, "Open Settings > Notification access > Watchtime Agent",
                    Toast.LENGTH_LONG).show();
        }
    }
}
