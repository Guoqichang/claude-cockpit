package com.looperhome.cockpit;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Polls /api/chats and notifies when a turn that was running finishes.
 * Web Push does not reach a plain WebView, so the shell does the watching itself.
 */
public class WatchService extends Service {

    private static final String CH_RUN = "cockpit_running";
    private static final String CH_DONE = "cockpit_done";
    private static final long POLL_MS = 20_000L;

    private Thread worker;
    private volatile boolean stop = false;
    private String base = "", token = "";

    public static void start(Context ctx, String base, String token) {
        Intent i = new Intent(ctx, WatchService.class);
        i.putExtra("base", base);
        i.putExtra("token", token);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel run = new NotificationChannel(CH_RUN, "监控中", NotificationManager.IMPORTANCE_MIN);
            run.setShowBadge(false);
            NotificationChannel done = new NotificationChannel(CH_DONE, "轮次完成", NotificationManager.IMPORTANCE_HIGH);
            done.enableVibration(true);
            nm.createNotificationChannel(run);
            nm.createNotificationChannel(done);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            if (intent.getStringExtra("base") != null) base = intent.getStringExtra("base");
            if (intent.getStringExtra("token") != null) token = intent.getStringExtra("token");
        }
        startForeground(1, ongoing("Cockpit 正在监控运行中的轮次"));
        if (worker == null) {
            worker = new Thread(this::loop, "cockpit-watch");
            worker.setDaemon(true);
            worker.start();
        }
        return START_STICKY;
    }

    private Notification ongoing(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH_RUN) : new Notification.Builder(this);
        return b.setContentTitle("Cockpit")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void notifyDone(String title, String body) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH_DONE) : new Notification.Builder(this);
        Notification n = b.setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .build();
        getSystemService(NotificationManager.class).notify((int) (System.currentTimeMillis() % 100000), n);
    }

    private void loop() {
        Set<String> running = new HashSet<>();
        Map<String, Long> started = new HashMap<>();
        while (!stop) {
            try {
                JSONArray chats = new JSONArray(get(base + "api/chats"));
                Set<String> now = new HashSet<>();
                for (int i = 0; i < chats.length(); i++) {
                    JSONObject c = chats.getJSONObject(i);
                    if (!c.optBoolean("running")) continue;
                    String ch = c.optString("ch");
                    now.add(ch);
                    started.put(ch, c.optLong("startedAt", System.currentTimeMillis()));
                }
                for (String ch : running) {
                    if (now.contains(ch)) continue;
                    long ms = System.currentTimeMillis() - started.getOrDefault(ch, System.currentTimeMillis());
                    long sec = Math.max(0, ms / 1000);
                    String dur = sec < 60 ? sec + "秒" : (sec / 60) + "分" + (sec % 60) + "秒";
                    notifyDone("轮次已完成", "耗时 " + dur + " · 点击查看");
                }
                running = now;
                startForeground(1, ongoing(running.isEmpty()
                        ? "没有运行中的轮次" : running.size() + " 个轮次运行中"));
            } catch (Exception e) {
                Log.w("cockpit", "poll failed: " + e);
            }
            try { Thread.sleep(POLL_MS); } catch (InterruptedException e) { return; }
        }
    }

    private String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(8000);
        if (!token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            return sb.toString();
        } finally { c.disconnect(); }
    }

    @Override
    public void onDestroy() {
        stop = true;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
