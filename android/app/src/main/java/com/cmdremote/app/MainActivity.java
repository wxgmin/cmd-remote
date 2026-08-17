package com.cmdremote.app;

import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "cmd_remote";
    private static final String KEY_URL = "server_url";
    private static final String KEY_TOKEN = "token";

    private WebView webView;
    private LinearLayout settingsView;
    private EditText urlInput;
    private EditText tokenInput;
    private TextView statusText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String savedUrl = prefs.getString(KEY_URL, "");
        String savedToken = prefs.getString(KEY_TOKEN, "");

        // QR deep link: cmdremote://connect?server=...&token=...
        String deepServer = null;
        String deepToken = null;
        if (getIntent() != null && getIntent().getData() != null) {
            try {
                deepServer = getIntent().getData().getQueryParameter("server");
                deepToken = getIntent().getData().getQueryParameter("token");
            } catch (Exception ignored) {}
        }

        if (deepServer != null && !deepServer.isEmpty()) {
            // Deep link wins: save and connect immediately.
            if (deepToken == null) deepToken = "";
            prefs.edit().putString(KEY_URL, deepServer).putString(KEY_TOKEN, deepToken).apply();
            openTerminal(deepServer, deepToken);
        } else if (savedUrl.isEmpty()) {
            showSettings(savedUrl, savedToken);
        } else {
            openTerminal(savedUrl, savedToken);
        }
    }

    private void showSettings(String currentUrl, String currentToken) {
        settingsView = new LinearLayout(this);
        settingsView.setOrientation(LinearLayout.VERTICAL);
        settingsView.setPadding(48, 96, 48, 48);

        TextView title = new TextView(this);
        title.setText("Cmd Remote");
        title.setTextSize(26);
        settingsView.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Connect to Command Code on your PC");
        subtitle.setTextSize(14);
        subtitle.setPadding(0, 0, 0, 16);
        settingsView.addView(subtitle);

        TextView hint = new TextView(this);
        hint.setText("Where to find these on your PC:\n1. Open the \"Cmd Remote Control Panel\" shortcut on your desktop (or run panel.cmd).\n2. Copy the \"Anywhere (Tailscale)\" server address and the access token from it.\n3. Paste them below.");
        hint.setTextSize(12);
        hint.setTextColor(0xFF9AA3B5);
        hint.setPadding(0, 0, 0, 28);
        settingsView.addView(hint);

        TextView urlLabel = new TextView(this);
        urlLabel.setText("PC server address:");
        urlLabel.setTextSize(13);
        settingsView.addView(urlLabel);

        urlInput = new EditText(this);
        urlInput.setHint("e.g. http://100.x.x.x:8788");
        urlInput.setText(currentUrl);
        urlInput.setSingleLine(true);
        settingsView.addView(urlInput);

        TextView tokenLabel = new TextView(this);
        tokenLabel.setText("Access token:");
        tokenLabel.setTextSize(13);
        tokenLabel.setPadding(0, 24, 0, 0);
        settingsView.addView(tokenLabel);

        tokenInput = new EditText(this);
        tokenInput.setHint("32-char hex token from the control panel");
        tokenInput.setText(currentToken);
        tokenInput.setSingleLine(true);
        settingsView.addView(tokenInput);

        statusText = new TextView(this);
        statusText.setTextSize(12);
        statusText.setPadding(0, 24, 0, 0);
        settingsView.addView(statusText);

        Button connectBtn = new Button(this);
        connectBtn.setText("Connect");
        connectBtn.setOnClickListener(v -> {
            String url = urlInput.getText().toString().trim();
            String token = tokenInput.getText().toString().trim();
            if (url.isEmpty()) {
                statusText.setText("Enter the server address (e.g. http://100.124.83.109:8788).");
                return;
            }
            if (token.isEmpty()) {
                statusText.setText("Enter the access token from the control panel.");
                return;
            }
            // Normalize: strip trailing slash, add scheme if missing.
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "http://" + url;
            }
            url = url.replaceAll("/+$", "");
            if (!url.matches("^https?://[\\w\\-.]+(:\\d+)?$")) {
                statusText.setText("That address doesn't look right. It should look like http://100.124.83.109:8788");
                return;
            }
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            prefs.edit().putString(KEY_URL, url).putString(KEY_TOKEN, token).apply();
            openTerminal(url, token);
        });
        settingsView.addView(connectBtn);

        Button clearBtn = new Button(this);
        clearBtn.setText("Clear saved settings");
        clearBtn.setOnClickListener(v -> {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
            statusText.setText("Settings cleared. Restart the app.");
        });
        settingsView.addView(clearBtn);

        setContentView(settingsView);
    }

    private void openTerminal(String baseUrl, String token) {
        webView = new WebView(this);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        // Allow cleartext (HTTP) traffic on the tailnet.

        String sep = baseUrl.contains("?") ? "&" : "?";
        String url = baseUrl + sep + "token=" + (token == null ? "" : token);
        webView.loadUrl(url);

        setContentView(webView);

        // Long-press options: open settings / reload.
        webView.setOnLongClickListener(v -> {
            AlertDialog.Builder b = new AlertDialog.Builder(this);
            b.setItems(new String[]{"Reload", "Change settings"}, (d, which) -> {
                if (which == 0) webView.reload();
                else {
                    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                    String u = prefs.getString(KEY_URL, "");
                    String t = prefs.getString(KEY_TOKEN, "");
                    webView.destroy();
                    showSettings(u, t);
                }
            });
            b.show();
            return true;
        });
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
