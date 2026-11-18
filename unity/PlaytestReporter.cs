// PlaytestReporter.cs: sends playtest telemetry from a Unity game to Playtest Room.
//
// Drop this file anywhere under Assets/. It starts itself after the first scene
// loads, but only when it finds room settings, so normal builds are unaffected.
//
// Settings, in priority order:
//   1. The page URL (WebGL builds embedded in a Playtest Room page):
//        ?ptRoom=<roomId>&ptEndpoint=<https://app>&ptPlayer=<name>#ptKey=<ingestKey>
//      The key rides in the fragment, which browsers never send to the game's
//      host (no access logs, no Referer). A key in the query string, as older
//      Playtest Room pages sent it, is still accepted; the fragment wins.
//   2. Static fields set from code before the first scene loads, or in the Editor:
//        PlaytestReporter.RoomId / IngestKey / Endpoint
//
// What it sends, batched every 2 seconds:
//   - session start/end, the active scene as the "level"
//   - FPS (average and worst) every 5 seconds, aggregated server-side
//   - every exception and error log, with its stack trace (deduplicated)
//   - your own calls: PlaytestReporter.Death(pos), .Mark("text", pos), .SetLevel("name")
//   - F8: pauses, captures a screenshot, and asks the player what happened
//
// Unity 2021.3+ (tested on Unity 6000.0). No dependencies.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.SceneManagement;

public class PlaytestReporter : MonoBehaviour
{
    public static string RoomId;
    public static string IngestKey;
    public static string Endpoint;
    public static string PlayerName;
    public static KeyCode ReportKey = KeyCode.F8;

    const float FlushInterval = 2f;
    const float HeartbeatInterval = 5f;
    const int MaxQueued = 200;
    const int MaxErrorsPerSession = 40;
    const int MaxBatch = 40;
    const int ScreenshotMaxWidth = 960;

    public static PlaytestReporter Instance { get; private set; }
    public static bool IsActive => Instance != null;

    readonly List<string> queue = new List<string>();
    readonly Dictionary<string, float> recentErrors = new Dictionary<string, float>();
    string sessionId;
    string level = "";
    bool sending;
    float retryAt;
    int errorsSent;

    // FPS window
    int frames;
    float frameTime;
    float worstFps = float.MaxValue;
    float lastHeartbeat;

    // F8 overlay
    bool overlayOpen;
    string note = "";
    int category;
    byte[] pendingScreenshot;
    float savedTimeScale = 1f;
    CursorLockMode savedLock;
    bool savedCursorVisible;
    static readonly string[] Categories = { "bug", "balance", "ux", "other" };
    static readonly string[] CategoryLabels = { "Bug", "Too hard/easy", "Confusing", "Other" };

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Boot()
    {
        ReadUrlSettings();
        if (string.IsNullOrEmpty(RoomId) || string.IsNullOrEmpty(IngestKey) || string.IsNullOrEmpty(Endpoint)) return;
        var go = new GameObject("PlaytestReporter");
        DontDestroyOnLoad(go);
        go.AddComponent<PlaytestReporter>();
    }

    static void ReadUrlSettings()
    {
        string url = Application.absoluteURL;
        if (string.IsNullOrEmpty(url)) return;
        string fragment = "";
        int hash = url.IndexOf('#');
        if (hash >= 0)
        {
            fragment = url.Substring(hash + 1);
            url = url.Substring(0, hash);
        }
        int q = url.IndexOf('?');
        // Query first, then fragment, so a fragment value overrides.
        if (q >= 0) ReadUrlParams(url.Substring(q + 1));
        ReadUrlParams(fragment);
    }

    static void ReadUrlParams(string paramString)
    {
        if (string.IsNullOrEmpty(paramString)) return;
        foreach (string pair in paramString.Split('&'))
        {
            int eq = pair.IndexOf('=');
            if (eq <= 0) continue;
            string k = pair.Substring(0, eq);
            string v = UnityWebRequest.UnEscapeURL(pair.Substring(eq + 1));
            if (k == "ptRoom") RoomId = v;
            else if (k == "ptKey") IngestKey = v;
            else if (k == "ptEndpoint") Endpoint = v.TrimEnd('/');
            else if (k == "ptPlayer") PlayerName = v;
        }
    }

    // ---------- public API ----------

    public static void Death(Vector3 position, string cause = null)
    {
        if (Instance) Instance.Enqueue("death", cause, position);
    }

    public static void Mark(string message, Vector3? position = null)
    {
        if (Instance) Instance.Enqueue("custom", message, position);
    }

    public static void SetLevel(string levelName)
    {
        if (!Instance || string.IsNullOrEmpty(levelName) || levelName == Instance.level) return;
        Instance.level = levelName;
        Instance.Enqueue("level", null, null);
    }

    // ---------- lifecycle ----------

    void Awake()
    {
        if (Instance != null) { Destroy(gameObject); return; }
        Instance = this;
        sessionId = Guid.NewGuid().ToString("N");
        if (string.IsNullOrEmpty(PlayerName)) PlayerName = "Player " + sessionId.Substring(0, 4);
        level = SceneManager.GetActiveScene().name;
        Application.logMessageReceived += OnLog;
        SceneManager.activeSceneChanged += OnSceneChanged;
        Enqueue("session_start", null, null);
        lastHeartbeat = Time.unscaledTime;
        StartCoroutine(FlushLoop());
    }

    void OnDestroy()
    {
        if (Instance != this) return;
        Application.logMessageReceived -= OnLog;
        SceneManager.activeSceneChanged -= OnSceneChanged;
        Instance = null;
    }

    void OnApplicationQuit()
    {
        Enqueue("session_end", null, null);
        StartCoroutine(Send(TakeBatch(), null, null, null));
    }

    void OnSceneChanged(Scene from, Scene to) => SetLevel(to.name);

    void Update()
    {
        float dt = Time.unscaledDeltaTime;
        if (dt > 0f && !overlayOpen)
        {
            frames++;
            frameTime += dt;
            worstFps = Mathf.Min(worstFps, 1f / dt);
        }
        if (Time.unscaledTime - lastHeartbeat >= HeartbeatInterval && frames > 0)
        {
            float avg = frames / Mathf.Max(frameTime, 0.0001f);
            Enqueue("heartbeat", null, null, avg, worstFps == float.MaxValue ? avg : worstFps);
            frames = 0; frameTime = 0f; worstFps = float.MaxValue;
            lastHeartbeat = Time.unscaledTime;
        }
        if (!overlayOpen && Input.GetKeyDown(ReportKey)) StartCoroutine(OpenOverlay());
    }

    void OnLog(string message, string stack, LogType type)
    {
        if (type != LogType.Exception && type != LogType.Error && type != LogType.Assert) return;
        if (message.StartsWith("[Playtest]")) return; // never report our own failures
        if (errorsSent >= MaxErrorsPerSession) return;
        string key = message + "|" + (stack.Length > 200 ? stack.Substring(0, 200) : stack);
        // The same error every frame becomes one event per 10 seconds.
        if (recentErrors.TryGetValue(key, out float at) && Time.unscaledTime - at < 10f) return;
        recentErrors[key] = Time.unscaledTime;
        errorsSent++;
        var sb = BeginEvent("error");
        Field(sb, "message", Truncate(message, 1000));
        Field(sb, "stack", Truncate(stack, 4000));
        Push(sb);
    }

    // ---------- events ----------

    void Enqueue(string type, string message, Vector3? position, float fpsAvg = 0, float fpsMin = 0)
    {
        var sb = BeginEvent(type);
        if (type == "heartbeat")
        {
            Number(sb, "fpsAvg", Mathf.Clamp(fpsAvg, 0, 1000));
            Number(sb, "fpsMin", Mathf.Clamp(fpsMin, 0, 1000));
        }
        if (!string.IsNullOrEmpty(message)) Field(sb, "message", Truncate(message, 200));
        if (position.HasValue) Vec(sb, "position", position.Value);
        Push(sb);
    }

    StringBuilder BeginEvent(string type)
    {
        var sb = new StringBuilder(128);
        sb.Append('{');
        Field(sb, "type", type, first: true);
        if (!string.IsNullOrEmpty(level)) Field(sb, "level", Truncate(level, 80));
        return sb;
    }

    void Push(StringBuilder sb)
    {
        sb.Append('}');
        if (queue.Count >= MaxQueued) queue.RemoveAt(0); // drop oldest when offline for long
        queue.Add(sb.ToString());
    }

    List<string> TakeBatch()
    {
        int n = Mathf.Min(MaxBatch, queue.Count);
        var batch = queue.GetRange(0, n);
        queue.RemoveRange(0, n);
        return batch;
    }

    IEnumerator FlushLoop()
    {
        var wait = new WaitForSecondsRealtime(FlushInterval);
        while (true)
        {
            yield return wait;
            if (!sending && queue.Count > 0 && Time.unscaledTime >= retryAt)
                yield return Send(TakeBatch(), null, null, null);
        }
    }

    IEnumerator Send(List<string> events, string reportNote, string reportCategory, byte[] screenshot)
    {
        sending = true;
        var body = new StringBuilder(256 + events.Count * 96);
        body.Append('{');
        Field(body, "sessionId", sessionId, first: true);
        Field(body, "playerName", Truncate(PlayerName, 40));
        Field(body, "buildVersion", Truncate(Application.version, 40));
        Field(body, "platform", Application.platform.ToString());
        body.Append(",\"events\":[").Append(string.Join(",", events)).Append(']');
        if (reportNote != null)
        {
            body.Append(",\"report\":{");
            Field(body, "note", Truncate(reportNote, 2000), first: true);
            Field(body, "category", reportCategory);
            if (!string.IsNullOrEmpty(level)) Field(body, "level", level);
            var player = FindPlayerPosition();
            if (player.HasValue) Vec(body, "position", player.Value);
            if (screenshot != null) Field(body, "screenshotJpegBase64", Convert.ToBase64String(screenshot));
            body.Append('}');
        }
        body.Append('}');

        using (var req = new UnityWebRequest(Endpoint + "/api/ingest/" + RoomId, "POST"))
        {
            req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body.ToString()));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            req.SetRequestHeader("X-Playtest-Key", IngestKey);
            req.timeout = 15;
            yield return req.SendWebRequest();

            long code = req.responseCode;
            if (req.result == UnityWebRequest.Result.Success)
            {
                retryAt = 0;
            }
            else if (code == 429 || code == 0 || code >= 500)
            {
                // Transient: put the events back and wait before trying again.
                queue.InsertRange(0, events);
                if (queue.Count > MaxQueued) queue.RemoveRange(MaxQueued, queue.Count - MaxQueued);
                retryAt = Time.unscaledTime + (code == 429 ? 4f : 8f);
            }
            else
            {
                // 4xx: bad key, ended playtest, or rejected payload. Retrying won't help.
                Debug.LogWarning("[Playtest] report rejected (" + code + "): " + req.downloadHandler.text);
                // Wrong key, unknown room, or ended playtest: stop for this session.
                if (code == 401 || code == 404 || code == 410) { enabled = false; StopAllCoroutines(); }
            }
        }
        sending = false;
    }

    static Vector3? FindPlayerPosition()
    {
        var tagged = GameObject.FindWithTag("Player");
        if (tagged) return tagged.transform.position;
        return Camera.main ? Camera.main.transform.position : (Vector3?)null;
    }

    // ---------- F8 report overlay ----------

    IEnumerator OpenOverlay()
    {
        yield return new WaitForEndOfFrame();
        var shot = ScreenCapture.CaptureScreenshotAsTexture();
        pendingScreenshot = EncodeScreenshot(shot);
        Destroy(shot);

        savedTimeScale = Time.timeScale;
        savedLock = Cursor.lockState;
        savedCursorVisible = Cursor.visible;
        Time.timeScale = 0f;
        Cursor.lockState = CursorLockMode.None;
        Cursor.visible = true;
        note = "";
        category = 0;
        overlayOpen = true;
    }

    static byte[] EncodeScreenshot(Texture2D src)
    {
        if (src.width <= ScreenshotMaxWidth) return src.EncodeToJPG(70);
        int w = ScreenshotMaxWidth;
        int h = Mathf.RoundToInt(src.height * (w / (float)src.width));
        var rt = RenderTexture.GetTemporary(w, h);
        Graphics.Blit(src, rt);
        var prev = RenderTexture.active;
        RenderTexture.active = rt;
        var small = new Texture2D(w, h, TextureFormat.RGB24, false);
        small.ReadPixels(new Rect(0, 0, w, h), 0, 0);
        small.Apply();
        RenderTexture.active = prev;
        RenderTexture.ReleaseTemporary(rt);
        byte[] jpg = small.EncodeToJPG(70);
        Destroy(small);
        return jpg;
    }

    void CloseOverlay(bool send)
    {
        if (send && note.Trim().Length > 0)
        {
            StartCoroutine(Send(TakeBatch(), note.Trim(), Categories[category], pendingScreenshot));
        }
        pendingScreenshot = null;
        overlayOpen = false;
        Time.timeScale = savedTimeScale;
        Cursor.lockState = savedLock;
        Cursor.visible = savedCursorVisible;
    }

    void OnGUI()
    {
        if (!overlayOpen) return;
        var e = Event.current;
        if (e.type == EventType.KeyDown)
        {
            if (e.keyCode == KeyCode.Return && !e.shift) { CloseOverlay(true); e.Use(); return; }
            if (e.keyCode == ReportKey) { CloseOverlay(false); e.Use(); return; }
        }

        float w = Mathf.Min(560, Screen.width - 40), h = 250;
        var rect = new Rect((Screen.width - w) / 2, (Screen.height - h) / 2, w, h);
        GUI.color = new Color(0, 0, 0, 0.6f);
        GUI.DrawTexture(new Rect(0, 0, Screen.width, Screen.height), Texture2D.whiteTexture);
        GUI.color = Color.white;
        GUI.Box(rect, GUIContent.none);
        GUILayout.BeginArea(new Rect(rect.x + 16, rect.y + 12, rect.width - 32, rect.height - 24));
        GUILayout.Label("<b>Report to the developer</b>  (screenshot attached)", new GUIStyle(GUI.skin.label) { richText = true });
        category = GUILayout.Toolbar(category, CategoryLabels);
        GUILayout.Space(6);
        GUI.SetNextControlName("pt-note");
        note = GUILayout.TextArea(note, 2000, GUILayout.Height(110));
        GUI.FocusControl("pt-note");
        GUILayout.Space(6);
        GUILayout.BeginHorizontal();
        GUILayout.Label("Enter sends · " + ReportKey + " cancels");
        GUILayout.FlexibleSpace();
        if (GUILayout.Button("Cancel", GUILayout.Width(80))) CloseOverlay(false);
        GUI.enabled = note.Trim().Length > 0;
        if (GUILayout.Button("Send", GUILayout.Width(80))) CloseOverlay(true);
        GUI.enabled = true;
        GUILayout.EndHorizontal();
        GUILayout.EndArea();
    }

    // ---------- tiny JSON writer ----------

    static void Field(StringBuilder sb, string name, string value, bool first = false)
    {
        if (!first) sb.Append(',');
        sb.Append('"').Append(name).Append("\":\"");
        foreach (char c in value ?? "")
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    static void Number(StringBuilder sb, string name, float value)
    {
        sb.Append(",\"").Append(name).Append("\":").Append(Round(value));
    }

    static void Vec(StringBuilder sb, string name, Vector3 v)
    {
        sb.Append(",\"").Append(name).Append("\":{\"x\":").Append(Round(v.x))
          .Append(",\"y\":").Append(Round(v.y)).Append(",\"z\":").Append(Round(v.z)).Append('}');
    }

    static string Round(float f)
    {
        if (float.IsNaN(f) || float.IsInfinity(f)) f = 0;
        return Math.Round(f, 2).ToString(CultureInfo.InvariantCulture);
    }

    static string Truncate(string s, int max) => s == null ? "" : s.Length <= max ? s : s.Substring(0, max);
}
