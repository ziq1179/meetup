package com.streamspace.meetup

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

const val MAIN_URL = "https://meetup-xi-lilac.vercel.app"
private const val ORANGE = 0xFFEA580C.toInt()
private const val ORANGE_DARK = 0xFF7C2D12.toInt()
private const val ORANGE_LIGHT = 0xFFFFEDD5.toInt()

/**
 * StreamSpace meeting app: home screen with saved rooms + a WebView meeting
 * surface. Rooms joined through shared links (?room=...) are saved locally and
 * pinned to the home screen.
 */
class MainActivity : Activity() {

    private lateinit var container: ViewGroup
    private lateinit var home: ScrollView
    private lateinit var recentsList: LinearLayout
    private var webView: WebView? = null
    private var lastSavedRoom: String? = null
    private var permissionsRequested = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        setContentView(container)
        buildHome()
        showHome()
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        val uri: Uri = intent.data ?: return
        if (uri.host != "meetup-xi-lilac.vercel.app") return
        val room = uri.getQueryParameter("room")
        if (!room.isNullOrBlank()) {
            openRoom(room)
        } else {
            openMain()
        }
    }

    // -------------------------------------------------------------------------
    // Home screen
    // -------------------------------------------------------------------------

    private fun buildHome() {
        home = ScrollView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.WHITE)
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(32), dp(24), dp(32))
        }

        column.addView(TextView(this).apply {
            text = "StreamSpace"
            textSize = 30f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(ORANGE_DARK)
        }, wrapContent())

        column.addView(TextView(this).apply {
            text = "Video meetings, joined from shared links\nsave here automatically."
            textSize = 14f
            setTextColor(0xFF78716C.toInt())
            gravity = Gravity.CENTER
            setPadding(0, dp(6), 0, dp(20))
        }, wrapContent(margins(bottomPx = dp(12))))

        column.addView(Button(this).apply {
            text = "New Meeting"
            setBackgroundColor(ORANGE)
            setTextColor(Color.WHITE)
            setTypeface(typeface, Typeface.BOLD)
            setOnClickListener { openMain() }
        }, matchParent(margins(bottomPx = dp(28))))

        column.addView(TextView(this).apply {
            text = "Recent Rooms"
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(0xFF44403C.toInt())
        }, wrapContent(margins(bottomPx = dp(10))))

        recentsList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(recentsList, matchParent())

        column.addView(TextView(this).apply {
            text = "Tip: long-press a room to forget it."
            textSize = 12f
            setTextColor(0xFFA8A29E.toInt())
            gravity = Gravity.CENTER
            setPadding(0, dp(20), 0, 0)
        }, wrapContent(margins(topPx = dp(12))))

        home.addView(column, matchParent())
        container.addView(home)
        refreshRecents()
    }

    private fun refreshRecents() {
        recentsList.removeAllViews()
        val rooms = RoomStore.listRooms(this)
        if (rooms.isEmpty()) {
            recentsList.addView(TextView(this).apply {
                text = "No rooms yet.\nJoin through a shared link and it will appear here."
                textSize = 13f
                setTextColor(0xFFA8A29E.toInt())
                gravity = Gravity.CENTER
                setPadding(0, dp(8), 0, dp(8))
            }, wrapContent())
            return
        }
        for (entry in rooms) {
            recentsList.addView(
                LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setBackgroundColor(ORANGE_LIGHT)
                    setPadding(dp(14), dp(10), dp(14), dp(10))
                    addView(TextView(this@MainActivity).apply {
                        text = entry.room
                        textSize = 15f
                        setTypeface(typeface, Typeface.BOLD)
                        setTextColor(ORANGE_DARK)
                    })
                    addView(TextView(this@MainActivity).apply {
                        text = formatRelative(entry.joinedAt)
                        textSize = 11f
                        setTextColor(0xFFC2410C.toInt())
                    })
                    setOnClickListener { openRoom(entry.room) }
                    setOnLongClickListener {
                        RoomStore.removeRoom(this@MainActivity, entry.room)
                        refreshRecents()
                        Toast.makeText(this@MainActivity, "Removed \"${entry.room}\"", Toast.LENGTH_SHORT).show()
                        true
                    }
                },
                LinearLayout.LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, dp(8)) }
            )
        }
    }

    private fun formatRelative(ts: Long): String {
        if (ts <= 0) return "earlier"
        val diff = System.currentTimeMillis() - ts
        val mins = diff / 60000
        return when {
            mins < 1 -> "just now"
            mins < 60 -> "$mins min ago"
            mins < 24 * 60 -> "${mins / 60}h ago"
            else -> "${mins / (24 * 60)}d ago"
        }
    }

    // -------------------------------------------------------------------------
    // WebView meeting surface
    // -------------------------------------------------------------------------

    private fun webViewOrNull(): WebView {
        webView?.let { return it }
        val wv = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            visibility = View.GONE
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowContentAccess = true
            settings.databaseEnabled = true
            settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            webViewClient = object : WebViewClient() {
                override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                    super.doUpdateVisitedHistory(view, url, isReload)
                    // The web app keeps the ?room= param in the URL while in a
                    // meeting; save every distinct room as it appears.
                    maybeSaveRoom(url)
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread { handleWebPermission(request) }
                }
            }
        }
        container.addView(wv, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        return wv
    }

    private fun handleWebPermission(request: PermissionRequest) {
        val resources = request.resources
        val wantsCam = resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
        val wantsMic = resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)

        val camOk = !wantsCam || granted(Manifest.permission.CAMERA)
        val micOk = !wantsMic || granted(Manifest.permission.RECORD_AUDIO)

        if (camOk && micOk) {
            request.grant(resources)
            return
        }

        // Ask the user; whatever the site asked for will be re-granted when the
        // page requests it again right after the system dialog.
        request.deny()
        val wanted = buildList {
            if (wantsCam && !granted(Manifest.permission.CAMERA)) add(Manifest.permission.CAMERA)
            if (wantsMic && !granted(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
        }
        if (wanted.isNotEmpty()) {
            requestPermissions(wanted.toTypedArray(), 101)
        }
    }

    private fun granted(permission: String): Boolean =
        checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun ensureMeetingPermissions() {
        if (permissionsRequested) return
        permissionsRequested = true
        val wanted = buildList {
            if (!granted(Manifest.permission.CAMERA)) add(Manifest.permission.CAMERA)
            if (!granted(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
        }
        if (wanted.isNotEmpty()) {
            requestPermissions(wanted.toTypedArray(), 100)
        }
    }

    // -------------------------------------------------------------------------
    // Navigation between home and meeting
    // -------------------------------------------------------------------------

    private fun showHome() {
        webViewOrNull().visibility = View.GONE
        home.visibility = View.VISIBLE
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        refreshRecents()
    }

    private fun showMeeting(url: String) {
        val wv = webViewOrNull()
        home.visibility = View.GONE
        wv.visibility = View.VISIBLE
        if (wv.url != url) {
            wv.stopLoading()
            wv.loadUrl(url)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        ensureMeetingPermissions()
    }

    fun openMain() {
        showMeeting(MAIN_URL)
    }

    fun openRoom(room: String) {
        showMeeting("$MAIN_URL/?room=" + Uri.encode(room))
    }

    // Save any room the web app navigates to (?room=...), so links joined
    // through invites appear on the home screen.
    private fun maybeSaveRoom(url: String) {
        val uri = Uri.parse(url)
        if (uri.host != "meetup-xi-lilac.vercel.app") return
        val room = uri.getQueryParameter("room") ?: return
        if (room.isBlank() || room == lastSavedRoom) return
        lastSavedRoom = room
        RoomStore.saveRoom(this, room)
    }

    override fun onBackPressed() {
        val wv = webView
        if (wv != null && wv.visibility == View.VISIBLE) {
            if (wv.canGoBack()) {
                wv.goBack()
            } else {
                showHome()
            }
        } else {
            super.onBackPressed()
        }
    }

    // -------------------------------------------------------------------------
    // dp / layout helpers
    // -------------------------------------------------------------------------

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun matchParent(margins: LinearLayout.LayoutParams? = null): LinearLayout.LayoutParams {
        val p = LinearLayout.LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        if (margins != null) p.setMargins(margins.leftMargin, margins.topMargin, margins.rightMargin, margins.bottomMargin)
        return p
    }

    private fun wrapContent(margins: LinearLayout.LayoutParams? = null): LinearLayout.LayoutParams {
        val p = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        if (margins != null) p.setMargins(margins.leftMargin, margins.topMargin, margins.rightMargin, margins.bottomMargin)
        return p
    }

    private fun margins(topPx: Int = 0, bottomPx: Int = 0): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            setMargins(0, topPx, 0, bottomPx)
        }

    companion object {
        private const val MATCH_PARENT = ViewGroup.LayoutParams.MATCH_PARENT
    }
}
