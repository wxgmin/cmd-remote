package com.cmdremote.app;

import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
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
    private ProgressBar progressBar;
    private LinearLayout errorView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleIntent(getIntent());
    }

    // Deep links can arrive while the app is already open (singleTask routes here).
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        String deepServer = null;
        String deepToken = null;
        if (intent != null && intent.getData() != null) {
            try {
                deepServer = intent.getData().getQueryParameter("server");
                deepToken = intent.getData().getQueryParameter("token");
            } catch (Exception ignored) {}
        }

        if (deepServer != null && !deepServer.isEmpty()) {
            if (deepToken == null) deepToken = "";
            // Guard: a deep link pointing at localhost is useless on a phone.
            if (deepServer.contains("localhost") || deepServer.contains("127.0.0.1")) {
                showSettings("", "");
                statusText.setText("That QR points at the PC itself. Scan the QR on your PC's Control Panel instead.");
                return;
            }
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(KEY_URL, deepServer).putString(KEY_TOKEN, deepToken).apply();
            openTerminal(deepServer, deepToken);
            return;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String savedUrl = prefs.getString(KEY_URL, "");
        String savedToken = prefs.getString(KEY_TOKEN, "");
        if (savedUrl.isEmpty()) {
            showSettings("", "");
        } else {
            openTerminal(savedUrl, savedToken);
        }
    }

    private void showSettings(String currentUrl, String currentToken) {
        settingsView = new LinearLayout(this);
        settingsView.setOrientation(LinearLayout.VERTICAL);
        settingsView.setPadding(48, 72, 48, 48);

        TextView title = new TextView(this);
        title.setText("Cmd Remote");
        title.setTextSize(26);
        title.setTextColor(0xFF111827);
        settingsView.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Use this phone to control your PC's Command Code.");
        subtitle.setTextSize(14);
        subtitle.setTextColor(0xFF6B7280);
        subtitle.setPadding(0, 0, 0, 20);
        settingsView.addView(subtitle);

        // Plain-language guide, no jargon
        TextView guide = new TextView(this);
        guide.setText("How to connect\n\n" +
                "1. On your PC, open the Cmd Remote app and click the Control Panel tab.\n" +
                "2. It shows a QR code. Open your phone's camera and point it at the QR.\n" +
                "3. This app will fill in everything and connect automatically.\n\n" +
                "No QR handy? Type the address and password from the Control Panel below.");
        guide.setTextSize(14);
        guide.setTextColor(0xFF374151);
        guide.setPadding(0, 0, 0, 28);
        settingsView.addView(guide);

        TextView urlLabel = new TextView(this);
        urlLabel.setText("PC address (from the Control Panel)");
        urlLabel.setTextSize(13);
        urlLabel.setTextColor(0xFF111827);
        settingsView.addView(urlLabel);

        urlInput = new EditText(this);
        urlInput.setHint("e.g. http://100.124.83.109:8788");
        urlInput.setText(currentUrl);
        urlInput.setSingleLine(true);
        urlInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        settingsView.addView(urlInput);

        TextView tokenLabel = new TextView(this);
        tokenLabel.setText("Password (the long secret from the Control Panel)");
        tokenLabel.setTextSize(13);
        tokenLabel.setTextColor(0xFF111827);
        tokenLabel.setPadding(0, 24, 0, 0);
        settingsView.addView(tokenLabel);

        tokenInput = new EditText(this);
        tokenInput.setHint("Paste the long password here");
        tokenInput.setText(currentToken);
        tokenInput.setSingleLine(true);
        tokenInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        settingsView.addView(tokenInput);

        statusText = new TextView(this);
        statusText.setTextSize(13);
        statusText.setTextColor(0xFFDC2626);
        statusText.setPadding(0, 20, 0, 0);
        settingsView.addView(statusText);

        Button connectBtn = new Button(this);
        connectBtn.setText("Connect");
        connectBtn.setTextColor(Color.WHITE);
        connectBtn.setBackgroundColor(0xFF2563EB);
        connectBtn.setOnClickListener(v -> {
            String url = urlInput.getText().toString().trim();
            String token = tokenInput.getText().toString().trim();
            if (url.isEmpty()) {
                statusText.setText("Enter the PC address (e.g. http://100.124.83.109:8788).");
                return;
            }
            if (token.isEmpty()) {
                statusText.setText("Enter the password from the Control Panel.");
                return;
            }
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "http://" + url;
            }
            url = url.replaceAll("/+$", "");
            if (!url.matches("^https?://[\\w\\-.]+(:\\d+)?$")) {
                statusText.setText("That address doesn't look right. It should look like http://100.124.83.109:8788");
                return;
            }
            connectBtn.setEnabled(false);
            connectBtn.setText("Connecting...");
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(KEY_URL, url).putString(KEY_TOKEN, token).apply();
            openTerminal(url, token);
        });
        settingsView.addView(connectBtn);

        Button clearBtn = new Button(this);
        clearBtn.setText("Clear saved settings");
        clearBtn.setTextColor(0xFF374151);
        clearBtn.setBackgroundColor(0xFFE5E7EB);
        clearBtn.setOnClickListener(v -> {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
            urlInput.setText("");
            tokenInput.setText("");
            statusText.setText("Settings cleared. You can enter new ones above.");
        });
        settingsView.addView(clearBtn);

        setContentView(settingsView);
    }

    private void openTerminal(String baseUrl, String token) {
        // Loading indicator
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);

        webView = new WebView(this);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (progressBar != null) progressBar.setVisibility(View.VISIBLE);
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                if (progressBar != null) progressBar.setVisibility(View.GONE);
            }
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showError("Can't reach your PC", "Check that your PC is on, connected to the internet, and that the address is correct. Then try again.");
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (progressBar != null) progressBar.setProgress(newProgress);
            }
        });
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setMediaPlaybackRequiresUserGesture(false);

        String sep = baseUrl.contains("?") ? "&" : "?";
        String url = baseUrl + sep + "token=" + (token == null ? "" : token);
        webView.loadUrl(url);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.addView(progressBar, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(webView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        // Long-press options: reload / settings.
        webView.setOnLongClickListener(v -> {
            AlertDialog.Builder b = new AlertDialog.Builder(this);
            b.setItems(new String[]{"Reload", "Change settings"}, (d, which) -> {
                if (which == 0) webView.reload();
                else {
                    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                    String u = prefs.getString(KEY_URL, "");
                    String t = prefs.getString(KEY_TOKEN, "");
                    showSettings(u, t);
                }
            });
            b.show();
            return true;
        });
    }

    private void showError(String title, String message) {
        if (errorView != null) {
            removeContentView();
        }
        errorView = new LinearLayout(this);
        errorView.setOrientation(LinearLayout.VERTICAL);
        errorView.setPadding(48, 96, 48, 48);

        TextView titleTv = new TextView(this);
        titleTv.setText(title);
        titleTv.setTextSize(22);
        titleTv.setTextColor(0xFF111827);
        errorView.addView(titleTv);

        TextView msgTv = new TextView(this);
        msgTv.setText(message);
        msgTv.setTextSize(14);
        msgTv.setTextColor(0xFF6B7280);
        msgTv.setPadding(0, 12, 0, 28);
        errorView.addView(msgTv);

        Button retryBtn = new Button(this);
        retryBtn.setText("Try again");
        retryBtn.setTextColor(Color.WHITE);
        retryBtn.setBackgroundColor(0xFF2563EB);
        retryBtn.setOnClickListener(v -> {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String u = prefs.getString(KEY_URL, "");
            String t = prefs.getString(KEY_TOKEN, "");
            openTerminal(u, t);
        });
        errorView.addView(retryBtn);

        Button settingsBtn = new Button(this);
        settingsBtn.setText("Change settings");
        settingsBtn.setTextColor(0xFF374151);
        settingsBtn.setBackgroundColor(0xFFE5E7EB);
        settingsBtn.setOnClickListener(v -> {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String u = prefs.getString(KEY_URL, "");
            String t = prefs.getString(KEY_TOKEN, "");
            showSettings(u, t);
        });
        errorView.addView(settingsBtn);

        setContentView(errorView);
    }

    private void removeContentView() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (errorView != null) {
            super.onBackPressed();
        } else if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
