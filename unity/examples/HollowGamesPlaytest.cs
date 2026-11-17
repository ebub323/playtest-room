// HollowGamesPlaytest.cs: wires The Hollow Games into PlaytestReporter
// without changing any of the game's own scripts.
//
// It watches GameManager's public state each frame and reports:
//   - entering a zone            -> level "<zone name>"
//   - a boss fight starting      -> marker "Boss fight: <boss>"
//   - game over                  -> death at the tribute's position, with hearts, zone and wave
//   - winning                    -> marker "Won the run"
//
// A game-specific adapter like this is the pattern for any project: the
// reporter stays generic, and ~50 lines translate one game's state.

using UnityEngine;

public class HollowGamesPlaytest : MonoBehaviour
{
    GameManager game;
    PlayerController player;
    int lastZone = -1;
    bool wasGameOver;
    Enemy lastBoss;

    // Unity runs all AfterSceneLoad hooks in no guaranteed order, so this can
    // start before PlaytestReporter does. Always start, and check each frame.
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Boot()
    {
        var go = new GameObject("HollowGamesPlaytest");
        DontDestroyOnLoad(go);
        go.AddComponent<HollowGamesPlaytest>();
    }

    void Update()
    {
        if (!PlaytestReporter.IsActive) return;
        if (!game)
        {
            // GameManager lives in the HollowGames scene, not the main menu.
            game = FindAnyObjectByType<GameManager>();
            player = FindAnyObjectByType<PlayerController>();
            lastZone = -1;
            wasGameOver = false;
            lastBoss = null;
            if (!game) return;
        }
        if (game.zones == null || game.zones.Length == 0) return;

        if (game.CurrentZoneIndex != lastZone && game.ZoneActive)
        {
            lastZone = game.CurrentZoneIndex;
            PlaytestReporter.SetLevel(game.CurrentZone.zoneName);
        }

        if (game.CurrentBoss && game.CurrentBoss != lastBoss)
        {
            lastBoss = game.CurrentBoss;
            PlaytestReporter.Mark("Boss fight: " + lastBoss.name.Replace("(Clone)", "").Trim(), lastBoss.transform.position);
        }

        if (game.IsGameOver && !wasGameOver)
        {
            Vector3 pos = game.Player ? game.Player.position : Vector3.zero;
            if (game.PlayerWon)
                PlaytestReporter.Mark("Won the run in " + Mathf.RoundToInt(game.RunTime) + "s, score " + game.Score, pos);
            else
                PlaytestReporter.Death(pos, "Died in " + game.CurrentZone.zoneName + ", wave " + game.CurrentWave +
                    (player ? ", hearts " + player.CurrentHearts + "/" + player.MaxHearts : ""));
        }
        wasGameOver = game.IsGameOver;
    }
}
