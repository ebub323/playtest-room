// PlaytestWebGLBuild.cs: one-command WebGL build that loads on any static host.
//
// Menu: Playtest Room > Build WebGL
// Command line:
//   Unity -batchmode -quit -projectPath <project> \
//     -executeMethod PlaytestWebGLBuild.Build -buildOutput <dir>
//
// Uses gzip with Unity's decompression fallback, so the build works on hosts
// that don't send Content-Encoding headers for .gz files (GitHub Pages,
// itch.io, a plain bucket). Player settings it changes are restored after the
// build so ProjectSettings stays clean in version control.

using System;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

public static class PlaytestWebGLBuild
{
    [MenuItem("Playtest Room/Build WebGL")]
    public static void BuildFromMenu() => Run("Builds/WebGL");

    public static void Build()
    {
        string output = "Builds/WebGL";
        var args = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(args, "-buildOutput");
        if (i >= 0 && i + 1 < args.Length) output = args[i + 1];
        var report = Run(output);
        EditorApplication.Exit(report != null && report.summary.result == BuildResult.Succeeded ? 0 : 1);
    }

    static BuildReport Run(string output)
    {
        string[] scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
        if (scenes.Length == 0)
        {
            Debug.LogError("[PlaytestBuild] No enabled scenes in Build Settings.");
            return null;
        }

        var prevCompression = PlayerSettings.WebGL.compressionFormat;
        var prevFallback = PlayerSettings.WebGL.decompressionFallback;
        var prevExceptions = PlayerSettings.WebGL.exceptionSupport;
        try
        {
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Gzip;
            PlayerSettings.WebGL.decompressionFallback = true;
            // Full stack traces make crash grouping meaningful in the dashboard.
            PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.FullWithStacktrace;

            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = scenes,
                locationPathName = output,
                target = BuildTarget.WebGL,
                options = BuildOptions.None,
            });
            var s = report.summary;
            Debug.Log($"[PlaytestBuild] {s.result}: {s.totalSize / (1024f * 1024f):F1} MB in {s.totalTime.TotalSeconds:F0}s -> {output}");
            return report;
        }
        finally
        {
            PlayerSettings.WebGL.compressionFormat = prevCompression;
            PlayerSettings.WebGL.decompressionFallback = prevFallback;
            PlayerSettings.WebGL.exceptionSupport = prevExceptions;
        }
    }
}
