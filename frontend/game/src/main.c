#include "raylib.h"
#include "raymath.h"
#include "bones_core.h"
#include "effects.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_PLAYERS  8
#define ANIM_COUNT   15

#define STAGE_LEFT   -8.0f
#define STAGE_RIGHT   8.0f
#define PLATFORM_H    0.12f

static float ATTACK_RANGE   = 0.525f;
static float ATTACK_RANGE_Y = 0.5f;

static int    SCREEN_W = 800;
static int    SCREEN_H = 600;
static Camera scene_cam;

#include "rlgl.h"

typedef struct {
    Mesh           mesh;
    Model          model;
    Shader         shader;
    TextureCubemap cubemap;
    int            locTime;
    bool           loaded;
    int            loadedStage;
} SkyboxState;

static SkyboxState g_sky = { {0}, {0}, {0}, {0}, 0, false, -1 };

static Texture2D g_platTex[4]   = {0};
static int       g_platTexStage = -1;

static Texture2D g_pbase         = {0};
static Texture2D g_portraits[5]  = {0};
static bool      g_hudTexLoaded  = false;

static Shader g_shdrOutline       = {0};
static int    g_outlineSizeLoc    = -1;
static int    g_outlineColorLoc   = -1;
static int    g_textureSizeLoc    = -1;

static const Color PLAYER_COLORS[8] = {
    { 80, 180, 255, 255},
    {255,  60,  60, 255},
    { 60, 220,  80, 255},
    {255, 210,   0, 255},
    {180,  60, 255, 255},
    {255, 140,   0, 255},
    {  0, 220, 200, 255},
    {255, 255, 255, 255},
};
static Model     g_platGroundModel;
static Model     g_platFloatModel;
static bool      g_platModelReady = false;

static void TileUVs(Mesh *m, float w, float d) {
    if (!m->texcoords) return;
    for (int i = 0; i < m->vertexCount; i++) {
        m->texcoords[i * 2 + 0] *= w;
        m->texcoords[i * 2 + 1] *= d;
    }
    UpdateMeshBuffer(*m, 1, m->texcoords, m->vertexCount * 2 * sizeof(float), 0);
}

static void PlatTex_Load(int stageId) {
    if (g_platTexStage == stageId) return;
    if (g_platTexStage >= 0 && g_platTex[g_platTexStage].id > 0)
        UnloadTexture(g_platTex[g_platTexStage]);

    char path[64];
    snprintf(path, sizeof(path), "assets/textures/plat%d.jpg", stageId);
    if (FileExists(path)) {
        g_platTex[stageId] = LoadTexture(path);
        SetTextureWrap(g_platTex[stageId], TEXTURE_WRAP_REPEAT);
    }
    g_platTexStage = stageId;

    if (g_platModelReady && g_platTex[stageId].id > 0) {
        SetMaterialTexture(&g_platGroundModel.materials[0], MATERIAL_MAP_DIFFUSE, g_platTex[stageId]);
        SetMaterialTexture(&g_platFloatModel.materials[0],  MATERIAL_MAP_DIFFUSE, g_platTex[stageId]);
    }
}

static void PlatTex_Unload(void) {
    for (int i = 0; i < 4; i++)
        if (g_platTex[i].id > 0) { UnloadTexture(g_platTex[i]); g_platTex[i].id = 0; }
    if (g_platModelReady) {
        UnloadModel(g_platGroundModel);
        UnloadModel(g_platFloatModel);
        g_platModelReady = false;
    }
    g_platTexStage = -1;
}

static void DrawCubeWithTex(Model *mdl, Vector3 pos, float w, float h, float d) {
    DrawModelEx(*mdl, pos, (Vector3){0,1,0}, 0.0f, (Vector3){w, h, d}, WHITE);
}

static void Skybox_Load(int stageId) {
    if (g_sky.loaded) {
        UnloadModel(g_sky.model);
        UnloadTexture(g_sky.cubemap);
        UnloadShader(g_sky.shader);
        g_sky.loaded = false;
    }

    char imgPath[128];
    snprintf(imgPath, sizeof(imgPath), "assets/textures/skybox%d.jpg", stageId);
    if (!FileExists(imgPath)) return;

    g_sky.shader = LoadShader("assets/shaders/skybox.vs", "assets/shaders/skybox.fs");
    int envMap = MATERIAL_MAP_CUBEMAP;
    int doGamma = 0, vflipped = 1;
    SetShaderValue(g_sky.shader, GetShaderLocation(g_sky.shader, "environmentMap"), &envMap,   SHADER_UNIFORM_INT);
    SetShaderValue(g_sky.shader, GetShaderLocation(g_sky.shader, "doGamma"),        &doGamma,  SHADER_UNIFORM_INT);
    SetShaderValue(g_sky.shader, GetShaderLocation(g_sky.shader, "vflipped"),       &vflipped, SHADER_UNIFORM_INT);
    g_sky.locTime = GetShaderLocation(g_sky.shader, "time");

    Image img     = LoadImage(imgPath);
    g_sky.cubemap = LoadTextureCubemap(img, CUBEMAP_LAYOUT_AUTO_DETECT);
    UnloadImage(img);

    g_sky.mesh  = GenMeshCube(1.0f, 1.0f, 1.0f);
    g_sky.model = LoadModelFromMesh(g_sky.mesh);
    g_sky.model.materials[0].shader = g_sky.shader;
    SetMaterialTexture(&g_sky.model.materials[0], MATERIAL_MAP_CUBEMAP, g_sky.cubemap);

    g_sky.loaded      = true;
    g_sky.loadedStage = stageId;
}

static void Skybox_Unload(void) {
    if (!g_sky.loaded) return;
    UnloadModel(g_sky.model);
    UnloadTexture(g_sky.cubemap);
    UnloadShader(g_sky.shader);
    g_sky.loaded      = false;
    g_sky.loadedStage = -1;
}

static void Skybox_Draw(Camera cam) {
    if (!g_sky.loaded) return;

    rlDisableBackfaceCulling();
    rlDisableDepthMask();
    rlEnableShader(g_sky.shader.id);

    if (g_sky.locTime >= 0) {
        float t = (float)GetTime();
        rlSetUniform(g_sky.locTime, &t, SHADER_UNIFORM_FLOAT, 1);
    }

    Matrix matView = MatrixLookAt(cam.position, cam.target, cam.up);
    matView.m12 = 0.0f; matView.m13 = 0.0f; matView.m14 = 0.0f;
    Matrix matProj = MatrixPerspective(
        cam.fovy * DEG2RAD,
        (float)SCREEN_W / (float)SCREEN_H,
        0.01f, 1000.0f);

    int locView = GetShaderLocation(g_sky.shader, "matView");
    int locProj = GetShaderLocation(g_sky.shader, "matProjection");
    if (locView >= 0) rlSetUniformMatrix(locView, matView);
    if (locProj >= 0) rlSetUniformMatrix(locProj, matProj);

    int locEnv = GetShaderLocation(g_sky.shader, "environmentMap");
    int slot = 0;
    if (locEnv >= 0) rlSetUniform(locEnv, &slot, SHADER_UNIFORM_INT, 1);
    rlActiveTextureSlot(0);
    rlEnableTextureCubemap(g_sky.cubemap.id);

    rlEnableVertexArray(g_sky.mesh.vaoId);
    int locPos = GetShaderLocationAttrib(g_sky.shader, "vertexPosition");
    if (locPos >= 0) {
        rlEnableVertexAttribute(locPos);
        rlSetVertexAttributeDivisor(locPos, 0);
    }
    rlDrawVertexArrayElements(0, g_sky.mesh.triangleCount * 3, 0);
    if (locPos >= 0) rlDisableVertexAttribute(locPos);
    rlDisableVertexArray();

    rlDisableTextureCubemap();
    rlDisableShader();
    rlEnableDepthMask();
    rlEnableBackfaceCulling();
}

static const char *ANIM_JSON[ANIM_COUNT] = {
    "assets/animations/idle.json",
    "assets/animations/walk.json",
    "assets/animations/jump.json",
    "assets/animations/attack_air.json",
    "assets/animations/attack_combo_1.json",
    "assets/animations/attack_combo_2.json",
    "assets/animations/attack_combo_3.json",
    "assets/animations/attack_crouch.json",
    "assets/animations/dash.json",
    "assets/animations/crouch.json",
    "assets/animations/crouch.json",
    "assets/animations/hurt.json",
    "assets/animations/block.json",
    "assets/animations/attack_dash.json",
    "assets/animations/victory.json",
};

static const char *ANIM_META[ANIM_COUNT] = {
    "assets/animations/idle.anim",
    "assets/animations/walk.anim",
    "assets/animations/jump.anim",
    "assets/animations/attack_air.anim",
    "assets/animations/attack_combo_1.anim",
    "assets/animations/attack_combo_2.anim",
    "assets/animations/attack_combo_3.anim",
    "assets/animations/attack_crouch.anim",
    "assets/animations/dash.anim",
    "assets/animations/crouch.anim",
    "assets/animations/crouch.anim",
    "assets/animations/hurt.anim",
    "assets/animations/block.anim",
    "assets/animations/attack_dash.anim",
    "assets/animations/victory.anim",
};

static const char *ANIM_NAME[ANIM_COUNT] = {
    "idle", "walk", "jump",
    "attack_air", "attack_combo_1", "attack_combo_2", "attack_combo_3",
    "attack_crouch", "dash", "crouch", "crouch_loop",
    "hurt", "block", "attack_dash",
    "victory",
};

typedef struct {
    int  id;
    int  active;

    float wx, wy;
    float rotation;
    float visualRotation;

    char animation[24];
    int  animIndex;

    int   stocks;
    bool  respawning;
    bool  crouching;
    int   hitId;
    int   jumpId;
    float voltage;
    bool  voltageMaxed;
    bool  blocking;

    float attackFlashTimer;
    float attackFlashFacing;

    float hitShakeAmt;
    float hitShakeTimer;

    Vector3 referenceCenter;
    bool    hasReferenceCenter;
    float   anchorYOffset;
    bool    hasAnchorY;

    AnimatedCharacter *character;

    char charId[32];
    char username[64];
    int  slotIndex;

    bool  victoryLanding;
    float visualWY;
    bool  visualWYInit;
    float victoryFallVY;
    float victoryLandingTargetY;

    float outlineTimer;
    float youTimer;
    bool  prevRespawning;

    FxState fx;
    bool    wasInAir;
} Player;

static Player players[MAX_PLAYERS];
static int    my_id        = -1;
static bool   is_spectator = false;
static bool   game_ready   = false;
static bool   debug_mode   = false;

static int PlayerColorIndex(const Player *p) {
    if (p->id == my_id) return 0;
    return (p->slotIndex % 7) + 1;
}

static bool PlayerClothTintColor(const Player *p, Color *outColor) {
    if (p->id == my_id) return false;
    if (!p->charId[0]) return false;

    int totalMatches = 0;
    for (int s = 0; s < MAX_PLAYERS; s++) {
        Player *q = &players[s];
        if (!q->active) continue;
        if (q->id == p->id) continue;
        if (strcmp(q->charId, p->charId) != 0) continue;
        totalMatches++;
    }

    if (totalMatches == 0) return false;

    if (outColor) *outColor = PLAYER_COLORS[PlayerColorIndex(p)];
    return true;
}

static int    no_id_frames = 0;
#define NO_ID_SPECTATOR_FRAMES 180

static bool  match_over       = false;
static bool  victory_pending  = false;
static int   winner_id        = -1;
static char  winner_message[80] = {0};
static float victory_msg_delay = 0.0f;
#define VICTORY_MSG_DELAY 999.0f

static float g_camShakeAmt   = 0.0f;
static float g_camShakeTimer = 0.0f;

#define MAX_PENDING 8
static int pending_ids[MAX_PENDING];
static int pending_count = 0;

static void InitPlayer(Player *p, int id);
static void FreePlayer(Player *p);
static void FetchState(void);
static void DrawGame(void);

int   ws_get_victory_state(void);
int   ws_get_victory_winner(void);
void  ws_consume_victory(void);
int   ws_overlay_ready(void);
int   ws_get_countdown(void);
float ws_get_countdown_elapsed(void);
int   ws_get_hitstop_frames_left(void);
float ws_get_hitstop_shake(void);
int   ws_get_hitstop_target_id(void);
int   ws_get_hitstop_tier_for_target(int targetId);
int   ws_get_hitstop_is_dash_attack(int targetId);

EM_JS(int, js_canvas_width, (void), {
    return (window._canvasWidth > 0) ? (window._canvasWidth | 0) : 800;
});
EM_JS(int, js_canvas_height, (void), {
    return (window._canvasHeight > 0) ? (window._canvasHeight | 0) : 600;
});
EM_JS(int, ws_get_my_id, (void), {
    return (window._myClientId > 0) ? (window._myClientId | 0) : -1;
});
EM_JS(int, ws_is_spectator, (void), {
    return (window._isSpectator && window._myClientId > 0) ? 1 : 0;
});
EM_JS(float, ws_get_attack_range, (void), {
    return (window._gameConfig && window._gameConfig.attackRange)
        ? window._gameConfig.attackRange : 0.525;
});
EM_JS(float, ws_get_attack_range_y, (void), {
    return (window._gameConfig && window._gameConfig.attackRangeY)
        ? window._gameConfig.attackRangeY : 0.5;
});
EM_JS(int, ws_player_count, (void), {
    if (!window._gameState || !window._gameState.players) return 0;
    return Object.keys(window._gameState.players).length;
});
EM_JS(int, ws_get_victory_state, (void), {
    if (!window._victoryActive || window._victoryConsumed) return 0;
    return window._victoryIsWinner ? 1 : 2;
});
EM_JS(int, ws_get_victory_winner, (void), {
    if (!window._victoryActive || window._victoryConsumed) return -1;
    return window._victoryWinner | 0;
});
EM_JS(void, ws_consume_victory, (void), {
    window._victoryConsumed = true;
    window._overlayReady    = false;
});
EM_JS(int, ws_overlay_ready, (void), {
    return (window._overlayReady && !window._victoryConsumed) ? 1 : 0;
});
EM_JS(int, ws_get_hitstop_frames_left, (void), {
    var hs = window._hitstopState;
    if (!hs || hs.framesLeft <= 0) { window._hitstopState = null; return 0; }
    var f = hs.framesLeft;
    hs.framesLeft--;
    return f;
});
EM_JS(float, ws_get_hitstop_shake, (void), {
    var hs = window._hitstopState;
    if (!hs || !hs.shakeAmt || hs.startFrames <= 0) return 0.0;
    var t = hs.framesLeft / hs.startFrames;
    if (t < 0.0) t = 0.0;
    return hs.shakeAmt * t;
});
EM_JS(int, ws_get_hitstop_target_id, (void), {
    var hs = window._hitstopState;
    if (!hs) return -1;
    return (hs.targetId | 0);
});
/* Devuelve el tier del golpe (índice en la tabla de abajo) si targetId
   coincide con el objetivo del hitstop actual; -1 si no hay info (p.ej.
   por una carrera de tiempos entre el mensaje 'hitstop' y la sync de
   estado). No consume el estado -- a diferencia de
   ws_get_hitstop_frames_left, puede llamarse varias veces sin efectos
   secundarios. */
EM_JS(int, ws_get_hitstop_tier_for_target, (int targetId), {
    var hs = window._hitstopState;
    if (!hs) return -1;
    if ((hs.targetId | 0) !== targetId) return -1;
    var tiers = ['micro', 'light', 'medium', 'heavy', 'ultra'];
    var idx = tiers.indexOf(hs.tier);
    return idx;
});
/* Igual que ws_get_hitstop_tier_for_target pero para el flag de dash
   attack: -1 si no hay info para ese targetId, 0/1 en caso contrario. */
EM_JS(int, ws_get_hitstop_is_dash_attack, (int targetId), {
    var hs = window._hitstopState;
    if (!hs) return -1;
    if ((hs.targetId | 0) !== targetId) return -1;
    return hs.isDashAttack ? 1 : 0;
});
EM_JS(int, ws_get_countdown, (void), {
    if (!window._countdownStart || window._countdownDone) return 0;
    var elapsed = (performance.now() - window._countdownStart) / 1000.0;
    if (elapsed < 1.2) return 1;
    if (elapsed < 2.2) return 2;
    window._countdownDone = true;
    return 0;
});
EM_JS(float, ws_get_countdown_elapsed, (void), {
    if (!window._countdownStart || window._countdownDone) return 0.0;
    return (performance.now() - window._countdownStart) / 1000.0;
});
EM_JS(int, ws_get_player, (int idx, char *buf, int len), {
    if (!window._gameState || !window._gameState.players) return 0;
    const ids = Object.keys(window._gameState.players);
    if (idx >= ids.length) return 0;
    const p = window._gameState.players[ids[idx]];
    if (!p) return 0;
    const fields = [
        p.id | 0,
        (p.x        ?? 0).toFixed(3),
        (p.y        ?? 0).toFixed(3),
        (p.rotation ?? 0).toFixed(4),
        p.animation || 'idle',
        p.stocks    ?? 3,
        p.respawning    ? 1 : 0,
        p.hitId     ?? 0,
        p.crouching     ? 1 : 0,
        p.jumpId    ?? 0,
        (p.voltage  ?? 0).toFixed(1),
        p.blocking      ? 1 : 0,
        p.voltageMaxed  ? 1 : 0,
    ].join('|');
    stringToUTF8(fields, buf, len);
    return 1;
});
EM_JS(int, ws_get_player_char_id_by_client, (int playerId, char *buf, int len), {    buf = buf | 0;
    if (!window._gameState || !window._gameState.players) {
        stringToUTF8("", buf, len); return 0;
    }
    var p = window._gameState.players[playerId];
    if (!p || !p.charId) { stringToUTF8("", buf, len); return 0; }
    stringToUTF8(p.charId, buf, len);
    return 1;
});
EM_JS(int, ws_get_player_username, (int playerId, char *buf, int len), {
    buf = buf | 0;
    if (!window._gameState || !window._gameState.players) {
        stringToUTF8("", buf, len); return 0;
    }
    var p = window._gameState.players[playerId];
    if (!p || !p.username) { stringToUTF8("", buf, len); return 0; }
    stringToUTF8(p.username, buf, len);
    return 1;
});

typedef struct { const char *charId, *name, *texCfg, *texSets, *animBase, *portrait; } CharDef;

static const CharDef CHARS[5] = {
    { "eld", "Eldwin",  "assets/textures/eld/bone_textures.txt", "assets/textures/eld/texture_sets.txt", "assets/animations/eld/", "assets/eldwin_portrait.jpg"  },
    { "hil", "Hilda",   "assets/textures/hil/bone_textures.txt", "assets/textures/hil/texture_sets.txt", "assets/animations/hil/", "assets/hilda_portrait.jpg"   },
    { "qui", "Quimbur", "assets/textures/qui/bone_textures.txt", "assets/textures/qui/texture_sets.txt", "assets/animations/qui/", "assets/quimbur_portrait.jpg" },
    { "gab", "Gabriel", "assets/textures/gab/bone_textures.txt", "assets/textures/gab/texture_sets.txt", "assets/animations/gab/", "assets/gabriel_portrait.jpg" },
    
    { "def", "Default", "assets/textures/default/bone_textures.txt", "assets/textures/default/texture_sets.txt", "assets/animations/default/", NULL },
};
#define CHARS_COUNT      5
#define CHARS_SELECTABLE 4

typedef struct { int id; const char *name; const char *preview; const char *desc; } StageDef;

static const StageDef STAGES[] = {
    { 0, "Karnamru",  "assets/stage_00.jpg", "City frozen in time"  },
    { 1, "Surya",     "assets/stage_01.jpg", "Eternal crystal lake" },
    { 2, "Vayusvara", "assets/stage_02.jpg", "Floating sky ruins"   },
    { 3, "Daat",      "assets/stage_03.jpg", "The hidden abyss"     },
};
#define STAGES_COUNT 4

typedef enum { SSS_SELECTING, SSS_WAITING, SSS_DONE } SssPhase;

static struct {
    SssPhase  phase;
    int       hovered;
    int       selected;
    Texture2D previews[STAGES_COUNT];
    bool      previewsLoaded;
    bool      isHost;
} g_sss = { SSS_SELECTING, 0, 0, {0}, false, false };

EM_JS(int, ws_is_host, (void), {
    var myId = window._myClientId;
    if (myId === undefined || myId === null || myId <= 0) return 0;
    if (window._isHost === true)  return 1;
    if (window._isHost === false) return 0;
    var gs = window._gameState;
    if (!gs || !gs.players) return 0;
    var ids = Object.keys(gs.players).map(function(k){ return parseInt(k); });
    if (ids.length === 0) return 0;
    var minId = ids.reduce(function(a,b){ return a < b ? a : b; });
    return (myId === minId) ? 1 : 0;
});
EM_JS(void, ws_send_stage_select, (int stageId), {
    if (typeof window.sendStageSelect === 'function') window.sendStageSelect(stageId | 0);
    try { sessionStorage.setItem('pendingStageId', stageId | 0); } catch(e) {}
});
EM_JS(int, ws_get_confirmed_stage, (void), {
    if (window._confirmedStageId !== undefined && window._confirmedStageId >= 0)
        return window._confirmedStageId | 0;
    try {
        var v = sessionStorage.getItem('confirmedStageId');
        if (v !== null && v.length > 0) {
            var n = parseInt(v, 10);
            if (!isNaN(n) && n >= 0) return n;
        }
    } catch(e) {}
    return -1;
});

static void SSS_LoadPreviews(void) {
    if (g_sss.previewsLoaded) return;
    for (int i = 0; i < STAGES_COUNT; i++) {
        if (FileExists(STAGES[i].preview))
            g_sss.previews[i] = LoadTexture(STAGES[i].preview);
    }
    g_sss.previewsLoaded = true;
}

static void SSS_UnloadPreviews(void) {
    if (!g_sss.previewsLoaded) return;
    for (int i = 0; i < STAGES_COUNT; i++) UnloadTexture(g_sss.previews[i]);
    g_sss.previewsLoaded = false;
}

static bool SSS_UpdateAndDraw(void) {
    g_sss.isHost = (bool)ws_is_host();

    {
        int confirmed = ws_get_confirmed_stage();
        if (confirmed >= 0) {
            int idx = 0;
            for (int i = 0; i < STAGES_COUNT; i++) {
                if (STAGES[i].id == confirmed) { idx = i; break; }
            }
            g_sss.selected = idx;
            g_sss.phase    = SSS_DONE;
            SSS_UnloadPreviews();
            return true;
        }
    }

    int sw = GetScreenWidth(), sh = GetScreenHeight();
    ClearBackground((Color){8, 8, 18, 255});

    int titleSz = (int)(sw * 0.038f); if (titleSz < 22) titleSz = 22; if (titleSz > 60) titleSz = 60;
    int nameSz  = (int)(sw * 0.022f); if (nameSz  < 14) nameSz  = 14; if (nameSz  > 34) nameSz  = 34;
    int descSz  = (int)(sw * 0.015f); if (descSz  < 11) descSz  = 11; if (descSz  > 22) descSz  = 22;
    int hintSz  = (int)(sw * 0.015f); if (hintSz  < 11) hintSz  = 11; if (hintSz  > 22) hintSz  = 22;
    int titleY  = (int)(sh * 0.04f);

    if (ws_get_my_id() <= 0) {
        const char *conn = "Conectando...";
        DrawText(conn, (sw - MeasureText(conn, titleSz)) / 2, sh / 2 - titleSz / 2,
                 titleSz, (Color){120, 160, 220, 255});
        return false;
    }

    if (!g_sss.isHost) {
        const char *wait = "Esperando seleccion de escenario...";
        DrawText(wait, (sw - MeasureText(wait, titleSz)) / 2, sh / 2 - titleSz / 2,
                 titleSz, (Color){160, 160, 200, 255});
        return false;
    }

    SSS_LoadPreviews();

    const char *title = "Elige el escenario";
    DrawText(title, (sw - MeasureText(title, titleSz)) / 2, titleY, titleSz, WHITE);

    int cardW    = (int)(sw * 0.88f / (STAGES_COUNT + (STAGES_COUNT - 1) * 0.06f));
    if (cardW < 100) cardW = 100;
    if (cardW > 320) cardW = 320;
    int previewH = (int)(cardW * 9.0f / 16.0f);
    int labelH   = (int)(cardW * 0.22f); if (labelH < 30) labelH = 30;
    int cardH    = previewH + labelH;
    int gap      = (int)(cardW * 0.06f); if (gap < 8) gap = 8;

    int totalW   = STAGES_COUNT * cardW + (STAGES_COUNT - 1) * gap;
    int startX   = (sw - totalW) / 2;
    int hintAreaH = hintSz + (int)(sh * 0.05f);
    int availH   = sh - (titleY + titleSz + (int)(sh * 0.02f)) - hintAreaH;
    int startY   = (titleY + titleSz + (int)(sh * 0.02f)) + (availH - cardH) / 2;
    if (startY + cardH > sh - hintAreaH - 4) startY = sh - hintAreaH - 4 - cardH;
    if (startY < titleY + titleSz + 8)       startY = titleY + titleSz + 8;

    Vector2 mouse = GetMousePosition();

    if (g_sss.phase == SSS_SELECTING) {
        for (int i = 0; i < STAGES_COUNT; i++) {
            Rectangle card = { startX + i*(cardW+gap), startY, cardW, cardH };
            if (CheckCollisionPointRec(mouse, card)) g_sss.hovered = i;
        }
        if (IsKeyPressed(KEY_LEFT)  || IsKeyPressed(KEY_A))
            g_sss.hovered = (g_sss.hovered + STAGES_COUNT - 1) % STAGES_COUNT;
        if (IsKeyPressed(KEY_RIGHT) || IsKeyPressed(KEY_D))
            g_sss.hovered = (g_sss.hovered + 1) % STAGES_COUNT;
    }

    for (int i = 0; i < STAGES_COUNT; i++) {
        Rectangle card  = { startX + i*(cardW+gap), startY, cardW, cardH };
        bool hover  = (g_sss.phase == SSS_SELECTING && i == g_sss.hovered);
        bool chosen = (i == g_sss.selected && g_sss.phase == SSS_WAITING);

        Color border = chosen ? GOLD : (hover ? WHITE : (Color){70, 70, 100, 255});
        Color bg     = chosen ? (Color){40,30,10,255} : (hover ? (Color){28,28,48,255} : (Color){16,16,30,255});

        DrawRectangleRec(card, bg);
        DrawRectangleLinesEx(card, chosen ? 3.0f : 2.0f, border);

        Rectangle previewRect = { card.x + 2, card.y + 2, cardW - 4, previewH - 2 };
        Texture2D tex = g_sss.previews[i];
        if (tex.id > 0) {
            DrawTexturePro(tex, (Rectangle){0,0,tex.width,tex.height}, previewRect, (Vector2){0,0}, 0.0f, WHITE);
        } else {
            Color placeholders[4] = {
                {40,60,110,255}, {20,60,50,255}, {90,30,20,255}, {30,50,30,255}
            };
            DrawRectangleRec(previewRect, placeholders[i % 4]);
            DrawText("?", previewRect.x + (previewRect.width  - MeasureText("?", 32)) / 2,
                          previewRect.y + (previewRect.height - 32) / 2, 32, (Color){200,200,200,120});
        }

        const char *nm  = STAGES[i].name;
        int nmY  = card.y + previewH + (labelH / 2 - nameSz) / 2;
        DrawText(nm, card.x + (cardW - MeasureText(nm, nameSz)) / 2, nmY, nameSz, border);

        const char *dsc = STAGES[i].desc;
        int dscY = nmY + nameSz + 2;
        if (dscY + descSz < card.y + cardH - 2)
            DrawText(dsc, card.x + (cardW - MeasureText(dsc, descSz)) / 2, dscY, descSz,
                     (Color){150,150,180,200});

        if (chosen) {
            static float blinkT = 0.0f;
            blinkT += GetFrameTime();
            if ((int)(blinkT * 4) % 2 == 0)
                DrawRectangleLinesEx(card, 4.0f, GOLD);
        }
    }

    if (g_sss.phase == SSS_SELECTING) {
        const char *hint = "Click o ENTER para elegir escenario";
        DrawText(hint, (sw - MeasureText(hint, hintSz)) / 2,
                 sh - (int)(sh * 0.05f), hintSz, GRAY);

        Rectangle hcard = { startX + g_sss.hovered*(cardW+gap), startY, cardW, cardH };
        bool click = IsMouseButtonPressed(MOUSE_LEFT_BUTTON) && CheckCollisionPointRec(mouse, hcard);
        bool enter = IsKeyPressed(KEY_ENTER) || IsKeyPressed(KEY_SPACE);
        if (click || enter) {
            g_sss.selected = g_sss.hovered;
            g_sss.phase    = SSS_WAITING;
            ws_send_stage_select(STAGES[g_sss.selected].id);
        }
    } else if (g_sss.phase == SSS_WAITING) {
        const char *wait = "Confirmando escenario...";
        DrawText(wait, (sw - MeasureText(wait, hintSz)) / 2,
                 sh - (int)(sh * 0.05f), hintSz, (Color){200,200,80,255});
    }

    return false;
}

typedef enum { CSS_SELECTING, CSS_WAITING_ACK, CSS_WAITING_GAME, CSS_DONE } CssPhase;

static struct {
    CssPhase  phase;
    int       hovered;
    int       selected;
    Texture2D portraits[CHARS_SELECTABLE];
    bool      portraitsLoaded;
    float     confirmTimer;
    char      savedCharId[32];
} g_css = { CSS_SELECTING, 0, -1, {0}, false, 0.0f, "" };

EM_JS(int, ws_char_select_ready, (void), {
    return (window._charSelectConfirmed && window._charSelectData && window._charSelectData.charId) ? 1 : 0;
});
EM_JS(int, ws_get_slot_char_id, (int slotIdx, char *buf, int len), {
    buf = buf | 0;
    if (!window._charSelectData || !window._charSelectData.players) { stringToUTF8("", buf, len); return 0; }
    var p = window._charSelectData.players[slotIdx];
    if (!p || !p.charId) { stringToUTF8("", buf, len); return 0; }
    stringToUTF8(p.charId, buf, len);
    return 1;
});
EM_JS(void, ws_send_char_select, (const char *charId, int charIdx, int stageId), {
    var id = UTF8ToString(charId);
    try { sessionStorage.setItem('pendingCharSelect', JSON.stringify({charId:id,charIdx:charIdx,stageId:stageId})); } catch(e){}
    if (typeof window.sendCharSelect === 'function') window.sendCharSelect(id, charIdx, stageId);
});

EM_JS(void, ws_send_fight_ready, (void), {
    if (typeof window.sendFightReady === 'function') window.sendFightReady();
});
EM_JS(int, ws_match_started, (void), {
    return (window._countdownStart != null || window._countdownDone === true) ? 1 : 0;
});
EM_JS(int, ws_get_saved_char_id, (char *buf, int len), {
    buf = buf | 0;
    try {
        var raw = sessionStorage.getItem('charSelectData');
        if (!raw) { stringToUTF8("", buf, len); return 0; }
        var d = JSON.parse(raw);
        if (!d || !d.charId) { stringToUTF8("", buf, len); return 0; }
        window._charSelectData = d;
        stringToUTF8(d.charId, buf, len);
        return 1;
    } catch(e) { stringToUTF8("", buf, len); return 0; }
});
EM_JS(void, ws_clear_char_select, (void), {
    window._charSelectData = null;
    try { sessionStorage.removeItem('pendingCharSelect'); sessionStorage.removeItem('charSelectData'); } catch(e){}
});

EM_JS(int, ws_needs_screen_reset, (void), {
    if (window._pendingScreenReset) {
        window._pendingScreenReset = false;
        return 1;
    }
    return 0;
});

static void strcpy_safe(char *dst, const char *src, size_t n) {
    strncpy(dst, src, n - 1);
    dst[n - 1] = '\0';
}

static int AnimIndex(const char *name) {
    for (int i = 0; i < ANIM_COUNT; i++)
        if (strcmp(name, ANIM_NAME[i]) == 0) return i;
    return 0;
}

static Vector3 CalcAnimCenter(const AnimationFrame *frame) {
    if (!frame || !frame->valid || frame->personCount == 0)
        return (Vector3){ 0, 0, 0 };
    Vector3 sum = { 0, 0, 0 };
    int     n   = 0;
    for (int pi = 0; pi < frame->personCount; pi++) {
        const Person *person = &frame->persons[pi];
        if (!person->active) continue;
        for (int b = 0; b < person->boneCount; b++) {
            const Bone *bone = &person->bones[b];
            if (!bone->position.valid) continue;
            sum = Vector3Add(sum, bone->position.position);
            n++;
        }
    }
    return n > 0 ? Vector3Scale(sum, 1.0f / (float)n) : (Vector3){ 0, 0, 0 };
}

static int FindBoneByName(const Person *person, const char *name) {
    if (!person || !name) return -1;
    for (int b = 0; b < person->boneCount; b++)
        if (strcmp(person->bones[b].name, name) == 0) return b;
    return -1;
}

static bool GetBonePosition(const AnimationFrame *frame, const char *name, Vector3 *outPos) {
    if (!frame || !outPos || !frame->valid) return false;
    for (int pi = 0; pi < frame->personCount; pi++) {
        const Person *person = &frame->persons[pi];
        if (!person->active) continue;
        int idx = FindBoneByName(person, name);
        if (idx >= 0 && person->bones[idx].position.valid) {
            *outPos = person->bones[idx].position.position;
            return true;
        }
    }
    return false;
}

static bool CalcAnkleMidPoint(const AnimationFrame *frame, Vector3 *outPos) {
    if (!frame || !outPos || !frame->valid) return false;
    Vector3 left = {0}, right = {0};
    bool hasL = GetBonePosition(frame, "LAnkle", &left);
    bool hasR = GetBonePosition(frame, "RAnkle", &right);
    if (!hasL || !hasR) return false;
    *outPos = Vector3Scale(Vector3Add(left, right), 0.5f);
    return true;
}

static void ApplyOffsetToAnim(BonesAnimation *anim, Vector3 offset) {
    if (!anim || !anim->isLoaded) return;
    for (int f = 0; f < anim->frameCount; f++) {
        AnimationFrame *frame = &anim->frames[f];
        if (!frame->valid) continue;
        for (int pi = 0; pi < frame->personCount; pi++) {
            Person *person = &frame->persons[pi];
            if (!person->active) continue;
            for (int b = 0; b < person->boneCount; b++) {
                Bone *bone = &person->bones[b];
                if (bone->position.valid)
                    bone->position.position = Vector3Add(bone->position.position, offset);
            }
        }
    }
}

static void StabilizeAnimX(BonesAnimation *anim) {
    if (!anim || !anim->isLoaded || anim->frameCount < 2) return;

    float baseX = 0.0f;
    int   n0    = 0;
    AnimationFrame *f0 = &anim->frames[0];
    for (int pi = 0; pi < f0->personCount; pi++) {
        const Person *person = &f0->persons[pi];
        if (!person->active) continue;
        for (int b = 0; b < person->boneCount; b++)
            if (person->bones[b].position.valid) {
                baseX += person->bones[b].position.position.x;
                n0++;
            }
    }
    if (n0 == 0) return;
    baseX /= (float)n0;

    for (int f = 1; f < anim->frameCount; f++) {
        AnimationFrame *frame = &anim->frames[f];
        if (!frame->valid) continue;
        float cx = 0.0f; int n = 0;
        for (int pi = 0; pi < frame->personCount; pi++) {
            const Person *person = &frame->persons[pi];
            if (!person->active) continue;
            for (int b = 0; b < person->boneCount; b++)
                if (person->bones[b].position.valid) { cx += person->bones[b].position.position.x; n++; }
        }
        if (n == 0) continue;
        float dx = baseX - (cx / (float)n);
        if (fabsf(dx) < 0.0001f) continue;
        for (int pi = 0; pi < frame->personCount; pi++) {
            Person *person = &frame->persons[pi];
            if (!person->active) continue;
            for (int b = 0; b < person->boneCount; b++)
                if (person->bones[b].position.valid)
                    person->bones[b].position.position.x += dx;
        }
    }
}

static float TransitionDuration(const char *anim) {
    if (!anim)                                return 0.10f;
    if (strncmp(anim, "idle",        4) == 0) return 0.10f;
    if (strncmp(anim, "walk",        4) == 0) return 0.10f;
    if (strncmp(anim, "jump",        4) == 0) return 0.08f;
    if (strncmp(anim, "crouch",      6) == 0) return 0.10f;
    if (strncmp(anim, "dash",        4) == 0) return 0.06f;
    if (strncmp(anim, "hurt",        4) == 0) return 0.10f;
    if (strncmp(anim, "block",       5) == 0) return 0.08f;
    if (strncmp(anim, "attack_dash", 11) == 0) return 0.06f;
    return 0.12f;
}

static bool LoadAnimWithOffset(Player *p, const char *jsonPath, const char *metaPath) {
    if (!p || !p->character) return false;
    if (!LoadAnimation(p->character, jsonPath, metaPath)) return false;

    SetAnimationTransitionDuration(p->character, TransitionDuration(p->animation));

    BonesAnimation *anim = &p->character->animation;
    if (!anim->isLoaded || anim->frameCount == 0) return true;

    StabilizeAnimX(anim);

    Vector3 thisCenter = {0};
    bool hasCtr = CalcAnkleMidPoint(&anim->frames[0], &thisCenter);
    if (!hasCtr) thisCenter = CalcAnimCenter(&anim->frames[0]);

    if (!p->hasReferenceCenter) {
        Vector3 xzOffset = { -thisCenter.x, 0.0f, -thisCenter.z };
        if (fabsf(xzOffset.x) > 0.001f || fabsf(xzOffset.z) > 0.001f)
            ApplyOffsetToAnim(anim, xzOffset);

        hasCtr = CalcAnkleMidPoint(&anim->frames[0], &thisCenter);
        if (!hasCtr) thisCenter = CalcAnimCenter(&anim->frames[0]);

        p->referenceCenter    = thisCenter;
        p->hasReferenceCenter = true;
        p->anchorYOffset      = thisCenter.y;
        p->hasAnchorY         = true;
    } else {
        Vector3 delta = Vector3Subtract(p->referenceCenter, thisCenter);
        if (Vector3Length(delta) > 0.001f)
            ApplyOffsetToAnim(anim, delta);
    }

    p->character->forceUpdate = true;
    return true;
}

static void QueuePlayerInit(int id) {
    for (int i = 0; i < pending_count; i++)
        if (pending_ids[i] == id) return;
    if (pending_count < MAX_PENDING)
        pending_ids[pending_count++] = id;
}

static void FlushOnePlayerInit(void) {
    if (pending_count == 0) return;

    int id = pending_ids[0];
    memmove(pending_ids, pending_ids + 1, (size_t)(pending_count - 1) * sizeof(int));
    pending_count--;

    for (int s = 0; s < MAX_PLAYERS; s++) {
        if (players[s].id == id && players[s].active == 2) {
            InitPlayer(&players[s], id);
            break;
        }
    }
}

static const CharDef *FindCharDef(const char *id) {
    if (!id || !id[0]) return NULL;
    for (int i = 0; i < CHARS_COUNT; i++)
        if (strcmp(id, CHARS[i].charId) == 0) return &CHARS[i];
    return NULL;
}

static void LoadPlayerAnim(Player *p, int animIdx) {
    const CharDef *cd  = FindCharDef(p->charId);
    const char *base   = (cd && cd->animBase[0]) ? cd->animBase : NULL;
    const char *origJson = ANIM_JSON[animIdx];
    const char *origMeta = ANIM_META[animIdx];
    if (base) {
        const char *jf = strrchr(origJson, '/'); jf = jf ? jf+1 : origJson;
        const char *mf = strrchr(origMeta, '/'); mf = mf ? mf+1 : origMeta;
        static char aj[256], am[256];
        snprintf(aj, sizeof(aj), "%s%s", base, jf);
        snprintf(am, sizeof(am), "%s%s", base, mf);
        if (FileExists(aj) && FileExists(am)) { LoadAnimWithOffset(p, aj, am); return; }
    }
    LoadAnimWithOffset(p, origJson, origMeta);
}

static void InitPlayer(Player *p, int id) {
    const Player prev = *p;

    memset(p, 0, sizeof(Player));
    p->id                 = id;
    p->active             = 1;
    p->animIndex          = prev.animIndex;
    p->wx                 = prev.wx;
    p->wy                 = prev.wy;
    p->rotation           = prev.rotation;
    p->visualRotation     = prev.visualRotation;
    p->stocks             = prev.stocks > 0 ? prev.stocks : 3;
    p->hitId              = prev.hitId;
    p->anchorYOffset      = prev.anchorYOffset;
    p->hasAnchorY         = prev.hasAnchorY;
    p->referenceCenter    = prev.referenceCenter;
    p->hasReferenceCenter = prev.hasReferenceCenter;
    strcpy_safe(p->animation, prev.animation, sizeof(p->animation));
    strncpy(p->charId, prev.charId, sizeof(p->charId)-1);
    p->slotIndex = prev.slotIndex;

    if (!p->charId[0]) {
        char cid[32] = {0};
        if (ws_get_player_char_id_by_client(p->id, cid, sizeof(cid)) && cid[0])
            strncpy(p->charId, cid, sizeof(p->charId)-1);
        else if (ws_get_slot_char_id(p->slotIndex, cid, sizeof(cid)) && cid[0])
            strncpy(p->charId, cid, sizeof(p->charId)-1);
    }

    const CharDef *cd   = FindCharDef(p->charId);
    const char *texCfg  = cd ? cd->texCfg  : "assets/textures/default/bone_textures.txt";
    const char *texSets = cd ? cd->texSets : "assets/textures/default/texture_sets.txt";

    p->character = CreateAnimatedCharacter(texCfg, texSets);

    if (p->character) {
        LockAnimationRootXZ(p->character, true);
        SetCharacterBillboards(p->character, true, true);
        SetCharacterAutoPlay(p->character, true);
        LoadPlayerAnim(p, p->animIndex);
    }
}

static void FreePlayer(Player *p) {
    if (p->character) {
        DestroyAnimatedCharacter(p->character);
        p->character = NULL;
    }
    p->active = 0;
    p->id     = -1;
}

static int ParsePlayer(const char *buf,
        int *id, float *x, float *y, float *rot,
        char *anim, int animLen,
        int *stocks, int *respawning, int *hitId,
        int *crouching, int *jumpId,
        float *voltage, int *blocking, int *voltageMaxed)
{
    char  tmp[256];
    char *tok;
    strncpy(tmp, buf, 255); tmp[255] = '\0';

    tok = strtok(tmp,  "|"); if (!tok) return 0; *id    = atoi(tok);
    tok = strtok(NULL, "|"); if (!tok) return 0; *x     = (float)atof(tok);
    tok = strtok(NULL, "|"); if (!tok) return 0; *y     = (float)atof(tok);
    tok = strtok(NULL, "|"); if (!tok) return 0; *rot   = (float)atof(tok);

    tok = strtok(NULL, "|");
    strncpy(anim, tok ? tok : "idle", (size_t)(animLen - 1));
    anim[animLen - 1] = '\0';

    tok = strtok(NULL, "|"); *stocks       = tok ? atoi(tok) : 3;
    tok = strtok(NULL, "|"); *respawning   = tok ? atoi(tok) : 0;
    tok = strtok(NULL, "|"); *hitId        = tok ? atoi(tok) : 0;
    tok = strtok(NULL, "|"); *crouching    = tok ? atoi(tok) : 0;
    tok = strtok(NULL, "|"); *jumpId       = tok ? atoi(tok) : 0;
    tok = strtok(NULL, "|"); *voltage      = tok ? (float)atof(tok) : 0.0f;
    tok = strtok(NULL, "|"); *blocking     = tok ? atoi(tok) : 0;
    tok = strtok(NULL, "|"); *voltageMaxed = tok ? atoi(tok) : 0;

    return 1;
}

static void FetchState(void) {
    int  count = ws_player_count();
    char buf[256];
    int  seen[MAX_PLAYERS] = {0};

    for (int i = 0; i < count && i < MAX_PLAYERS; i++) {
        if (!ws_get_player(i, buf, sizeof(buf))) continue;

        int   pid, pstocks, prespawning, phitId, pcrouching, pjumpId, pblocking, pvoltageMaxed;
        float px, py, prot, pvoltage;
        char  panim[24];

        if (!ParsePlayer(buf, &pid, &px, &py, &prot, panim, sizeof(panim),
                    &pstocks, &prespawning, &phitId, &pcrouching, &pjumpId,
                    &pvoltage, &pblocking, &pvoltageMaxed)) continue;

        if (is_spectator && my_id > 0 && pid == my_id) continue;

        int slot = -1;
        for (int s = 0; s < MAX_PLAYERS; s++)
            if (players[s].active && players[s].id == pid) { slot = s; break; }
        if (slot < 0)
            for (int s = 0; s < MAX_PLAYERS; s++)
                if (!players[s].active) { slot = s; break; }
        if (slot < 0) continue;

        if (!players[slot].active) {
            players[slot].id        = pid;
            players[slot].active    = 2;
            players[slot].slotIndex = slot;
            {
                char _cid[32] = {0};
                if (ws_get_player_char_id_by_client(pid, _cid, sizeof(_cid)) && _cid[0]) {
                    strncpy(players[slot].charId, _cid, sizeof(players[slot].charId)-1);
                } else if (ws_get_slot_char_id(slot, _cid, sizeof(_cid)) && _cid[0]) {                    strncpy(players[slot].charId, _cid, sizeof(players[slot].charId)-1);
                }
            }
            if (!players[slot].charId[0])
                strncpy(players[slot].charId, "default", sizeof(players[slot].charId)-1);

            {
                char _uname[64] = {0};
                ws_get_player_username(pid, _uname, sizeof(_uname));
                strncpy(players[slot].username, _uname, sizeof(players[slot].username)-1);
            }

            players[slot].animIndex = AnimIndex(panim);
            strcpy_safe(players[slot].animation, panim, sizeof(players[slot].animation));
            QueuePlayerInit(pid);
        }

        seen[slot] = 1;

        if (!players[slot].username[0]) {
            char _uname[64] = {0};
            if (ws_get_player_username(pid, _uname, sizeof(_uname)) && _uname[0])
                strncpy(players[slot].username, _uname, sizeof(players[slot].username)-1);
        }

        {
            char _newCid[32] = {0};
            ws_get_player_char_id_by_client(pid, _newCid, sizeof(_newCid));
            if (_newCid[0] && strncmp(_newCid, players[slot].charId, sizeof(players[slot].charId)) != 0) {
                strncpy(players[slot].charId, _newCid, sizeof(players[slot].charId)-1);
                if (players[slot].character) {
                    DestroyAnimatedCharacter(players[slot].character);
                    players[slot].character = NULL;
                }
                players[slot].active             = 2;
                players[slot].hasReferenceCenter = false;
                players[slot].hasAnchorY         = false;
                players[slot].animIndex          = AnimIndex(panim);
                strcpy_safe(players[slot].animation, panim, sizeof(players[slot].animation));
                QueuePlayerInit(pid);
            }
        }

        players[slot].wx           = px;
        players[slot].wy           = py;
        players[slot].rotation     = prot;
        if (players[slot].active == 2) players[slot].visualRotation = prot;
        players[slot].stocks       = pstocks;
        players[slot].respawning   = (bool)prespawning;
        players[slot].crouching    = (bool)pcrouching;
        players[slot].voltage      = pvoltage;
        players[slot].voltageMaxed = (bool)pvoltageMaxed;
        players[slot].blocking     = (bool)pblocking;

        if (phitId != players[slot].hitId) {
            players[slot].hitId = phitId;

            float hitFacing = (players[slot].rotation > 1.0f) ? -1.0f : 1.0f;

            /* Fila 2 del sheet ('bighit') es un golpe fuerte, no un efecto
               de bloqueo -- se elige según el tier de hitstop calculado en
               el servidor (physics.js: calcHitstop), no según si el
               jugador estaba bloqueando. 'heavy' y 'ultra' son los índices
               3 y 4 en la tabla de tiers. Si por una carrera de tiempos
               aún no ha llegado el mensaje 'hitstop' correspondiente
               (tier == -1), se usa el efecto normal de HIT por defecto.

               Los dash attacks también cuentan como golpe fuerte aunque el
               voltaje del atacante no alcance el tier 'heavy'/'ultra' --
               el impacto visual del embiste debe notarse siempre, no solo
               cuando el voltaje está cerca del 200%. */
            int tier = ws_get_hitstop_tier_for_target(players[slot].id);
            bool isDashHit = (ws_get_hitstop_is_dash_attack(players[slot].id) == 1);
            bool isBigHit = (tier >= 3) || isDashHit;

            Fx_Trigger(&players[slot].fx, isBigHit ? FX_BIGHIT : FX_HIT,
                       players[slot].wx, players[slot].wy, hitFacing);

            if (players[slot].character) {
                int ai = AnimIndex("hurt");
                LoadPlayerAnim(&players[slot], ai);
                SetCharacterAutoPlay(players[slot].character, true);
                players[slot].animIndex = ai;
                strcpy_safe(players[slot].animation, "hurt", sizeof(players[slot].animation));
            }
        } else if (pjumpId != players[slot].jumpId) {
            players[slot].jumpId = pjumpId;
            if (players[slot].character) {
                int ai = AnimIndex("jump");
                LoadPlayerAnim(&players[slot], ai);
                SetCharacterAutoPlay(players[slot].character, true);
                players[slot].animIndex = ai;
                strcpy_safe(players[slot].animation, "jump", sizeof(players[slot].animation));
            }
            players[slot].wasInAir = true;
        } else if (strncmp(players[slot].animation, panim, sizeof(players[slot].animation)) != 0) {

            if (!players[slot].victoryLanding) {
                int ai = AnimIndex(panim);
                if (ai != players[slot].animIndex && players[slot].character) {
                    LoadPlayerAnim(&players[slot], ai);
                    SetCharacterAutoPlay(players[slot].character, true);
                    players[slot].animIndex = ai;
                }
                if (strncmp(panim, "attack", 6) == 0 &&
                        strncmp(players[slot].animation, "attack", 6) != 0) {
                    players[slot].attackFlashTimer  = 0.3f;
                    players[slot].attackFlashFacing = (prot > 1.0f) ? -1.0f : 1.0f;
                }
                if (strncmp(panim, "dash", 4) == 0 &&
                        strncmp(players[slot].animation, "dash", 4) != 0) {
                    float facing = (prot > 1.0f) ? -1.0f : 1.0f;
                    Fx_Trigger(&players[slot].fx, FX_DASH, players[slot].wx, players[slot].wy, facing);
                }
                if (strncmp(panim, "jump", 4) == 0 &&
                        strncmp(players[slot].animation, "jump", 4) != 0) {
                    players[slot].wasInAir = true;
                }
                if (players[slot].wasInAir && strncmp(panim, "jump", 4) != 0) {
                    players[slot].wasInAir = false;
                    Fx_Trigger(&players[slot].fx, FX_LANDING, players[slot].wx, players[slot].wy, 1.0f);
                }
                strcpy_safe(players[slot].animation, panim, sizeof(players[slot].animation));
            }
        }
    }

    for (int s = 0; s < MAX_PLAYERS; s++) {
        if (!players[s].active || seen[s]) continue;
        for (int q = 0; q < pending_count; q++) {
            if (pending_ids[q] != players[s].id) continue;
            memmove(pending_ids + q, pending_ids + q + 1,
                    (size_t)(pending_count - q - 1) * sizeof(int));
            pending_count--;
            break;
        }
        if (players[s].active == 1) FreePlayer(&players[s]);
        else { players[s].active = 0; players[s].id = -1; }
    }
}

static Color LerpColor(Color a, Color b, float u) {
    return (Color){
        (unsigned char)(a.r + (b.r - a.r) * u),
        (unsigned char)(a.g + (b.g - a.g) * u),
        (unsigned char)(a.b + (b.b - a.b) * u),
        (unsigned char)(a.a + (b.a - a.a) * u),
    };
}

static const Color VOLTAGE_COL_BLUE   = { 20,  80, 255, 230 };
static const Color VOLTAGE_COL_YELLOW = {255, 220,   0, 230 };
static const Color VOLTAGE_COL_RED    = {255,   0,   0, 230 };

static Color VoltageBarColor(float t) {
    if (t <= 0.5f) return LerpColor(VOLTAGE_COL_BLUE,   VOLTAGE_COL_YELLOW, t * 2.0f);
    else           return LerpColor(VOLTAGE_COL_YELLOW, VOLTAGE_COL_RED,    (t - 0.5f) * 2.0f);
}

#define CAM_FOV_MIN    27.0f
#define CAM_FOV_MAX    74.0f
#define CAM_FOV_SPEC   50.0f
#define CAM_Y_DEFAULT  1.2f

typedef struct { float cx, cy, hw; } PlatDef;
typedef struct { float groundHw; int platCount; PlatDef plats[3]; } StageLayout;

#define PLAT_VISUAL_OFFSET       0.1f
#define PLAT_MAIN_VISUAL_OFFSET  0.05f

static const StageLayout STAGE_DRAW[] = {
    { 7.3f, 3, {{ -4.0f, 1.4f, 1.2f }, {  4.0f, 1.4f, 1.2f }, {  0.0f, 2.6f, 1.2f }} },
    { 7.3f, 3, {{ -3.0f, 1.1f, 1.1f }, {  3.0f, 1.1f, 1.1f }, {  0.0f, 2.2f, 1.1f }} },
    { 3.0f, 3, {{ -3.5f, 3.2f, 1.3f }, {  3.5f, 3.2f, 1.3f }, {  0.0f, 1.9f, 1.1f }} },
    { 7.3f, 0, {{ 0 }} },
};

static float FindLandingY(float wx, float wy) {
    int sid = g_sss.selected;
    if (sid < 0 || sid >= 4) sid = 0;
    const StageLayout *sl = &STAGE_DRAW[sid];

    float best = 0.0f;
    for (int i = 0; i < sl->platCount; i++) {
        float cy = sl->plats[i].cy - PLAT_VISUAL_OFFSET;
        float hw = sl->plats[i].hw;

        if (cy < wy && fabsf(wx - sl->plats[i].cx) <= hw + 0.3f) {
            if (cy > best) best = cy;
        }
    }
    return best;
}

static float g_voidTime = 0.0f;

static void DrawDaatGrid(Camera cam) {
    const float cellSize = 2.0f;
    const float gridHalf = 80.0f;
    const float floorY   = -1.5f;
    const float ceilY    =  4.5f;

    float scroll = fmodf(g_voidTime * 0.5f, cellSize);

    BeginMode3D(cam);
    BeginBlendMode(BLEND_ADDITIVE);
    rlSetLineWidth(1.5f);

    float planes[2] = { floorY, ceilY };
    for (int pl = 0; pl < 2; pl++) {
        float py = planes[pl];
        unsigned char a = (pl == 0) ? 160 : 80;

        rlBegin(RL_LINES);
        for (float x = -gridHalf; x <= gridHalf + 0.01f; x += cellSize) {
            rlColor4ub(40, 160, 255, a);
            rlVertex3f(x, py, -gridHalf + scroll);
            rlVertex3f(x, py,  gridHalf + scroll);
        }
        for (float z = -gridHalf; z <= gridHalf + 0.01f; z += cellSize) {
            rlColor4ub(40, 160, 255, a);
            rlVertex3f(-gridHalf, py, z + scroll);
            rlVertex3f( gridHalf, py, z + scroll);
        }
        rlEnd();
    }

    EndBlendMode();
    rlSetLineWidth(1.0f);
    EndMode3D();
}

static void HUD_LoadTextures(void) {
    if (g_hudTexLoaded) return;
    g_hudTexLoaded = true;
    if (FileExists("assets/pbase.png"))
        g_pbase = LoadTexture("assets/pbase.png");
    const char *pfiles[5] = {
        "assets/p00.png", "assets/p01.png", "assets/p02.png", "assets/p03.png", "assets/p04.png"
    };
    for (int i = 0; i < 5; i++)
        if (FileExists(pfiles[i]))
            g_portraits[i] = LoadTexture(pfiles[i]);

    const char *fsPath = "assets/shaders/outline.fs";
    if (FileExists(fsPath)) {
        g_shdrOutline     = LoadShader(0, fsPath);
        g_outlineSizeLoc  = GetShaderLocation(g_shdrOutline, "outlineSize");
        g_outlineColorLoc = GetShaderLocation(g_shdrOutline, "outlineColor");
        g_textureSizeLoc  = GetShaderLocation(g_shdrOutline, "textureSize");
        float sz = 2.0f;
        SetShaderValue(g_shdrOutline, g_outlineSizeLoc, &sz, SHADER_UNIFORM_FLOAT);
    }
}

static int CharIndexOf(const char *charId) {
    if (!charId || !charId[0]) return -1;
    for (int i = 0; i < CHARS_COUNT; i++)
        if (strcmp(CHARS[i].charId, charId) == 0) return i;
    return -1;
}

static void DrawPortraitWidget(int cx, int cy, int size,
                               int charIdx, int playerId,
                               float voltage, bool voltageMaxed, bool blinkOn,
                               int stocks, bool isMe)
{
    float radius = size * 0.5f;
    float arcOuter = radius * 0.82f;
    float arcInner = radius * 0.66f;

    Vector2 center = { (float)cx, (float)cy };

    if (!isMe) {
        int ci = 1;
        for (int _s = 0; _s < MAX_PLAYERS; _s++)
            if (players[_s].active && players[_s].id == playerId)
                { ci = PlayerColorIndex(&players[_s]); break; }
        Color pc = PLAYER_COLORS[ci];
        pc.a = 255;
        DrawCircleV(center, radius * 0.62f, pc);
    }

    if (charIdx >= 0 && charIdx < 5 && g_portraits[charIdx].id > 0) {
        Texture2D tex = g_portraits[charIdx];
        Rectangle src = { 0, 0, isMe ? (float)tex.width : -(float)tex.width, (float)tex.height };
        Rectangle dst = { cx - radius, cy - radius, (float)size, (float)size };
        DrawTexturePro(tex, src, dst, (Vector2){0,0}, 0.0f, WHITE);
    }

    float t = voltage / 200.0f;
    if (t > 1.0f) t = 1.0f;
    if (t > 0.0f) {
        float arcSpan    = 180.0f * t;
        float startAngle = 90.0f;
        float endAngle   = 90.0f + arcSpan;

        Color arcCol;
        if (voltageMaxed) {
            arcCol = blinkOn ? (Color){255,30,30,255} : (Color){255,160,0,255};
        } else {
            arcCol = VoltageBarColor(t);
        }
        arcCol.a = 240;

        int segments = (int)(arcSpan / 3.0f);
        if (segments < 6) segments = 6;

        DrawRing(center, arcInner, arcOuter, startAngle, endAngle, segments, arcCol);

        if (voltageMaxed && blinkOn)
            DrawRingLines(center, arcInner, arcOuter, startAngle, endAngle,
                          segments, (Color){255,80,80,220});
    }

    if (g_pbase.id > 0) {
        Rectangle src = { 0, 0, (float)g_pbase.width, (float)g_pbase.height };
        Rectangle dst = { cx - radius, cy - radius, (float)size, (float)size };
        DrawTexturePro(g_pbase, src, dst, (Vector2){0,0}, 0.0f, WHITE);
    } else {
        Color bc = isMe ? (Color){255,215,0,200} : (Color){160,160,200,180};
        DrawRing(center, radius * 0.85f, radius, 0.0f, 360.0f, 40, bc);
    }

    {
        int dotR   = (int)(size * 0.06f); if (dotR < 3) dotR = 3;
        int dotGap = dotR * 3;
        int totalW = stocks * dotGap - (dotGap - dotR * 2);
        int dotY   = cy + (int)radius + dotR + 6;
        int dotX0  = cx - totalW / 2 + dotR;
        Color dotCol = isMe ? (Color){255,215,0,230} : (Color){200,200,220,200};
        for (int d = 0; d < stocks; d++)
            DrawCircle(dotX0 + d * dotGap, dotY, (float)dotR, dotCol);
    }
}

static void DrawGame(void) {
    static float camX       = 0.0f;
    static float camY       = CAM_Y_DEFAULT;
    static float camTargetX  = 0.0f;
    static float camTargetY  = CAM_Y_DEFAULT;
    if (!victory_pending && !match_over) {
        camTargetX = camX;
        camTargetY = camY;
    }
    static float camFov     = CAM_FOV_SPEC;
    static float camZ       = 9.0f;
    static float blinkTimer = 0.0f;
    static bool  blinkOn    = true;

    const float dt = GetFrameTime();

    if (g_sky.loadedStage  != g_sss.selected) Skybox_Load(g_sss.selected);
    if (g_platTexStage     != g_sss.selected) PlatTex_Load(g_sss.selected);

    int   hitstopFrames = ws_get_hitstop_frames_left();
    float shakeAmt      = ws_get_hitstop_shake();
    int   targetId      = ws_get_hitstop_target_id();

    float animDt = (hitstopFrames > 0) ? 0.0f : dt;

    if (shakeAmt > 0.0f && shakeAmt > g_camShakeAmt) {
        g_camShakeAmt   = shakeAmt;
        g_camShakeTimer = 0.18f;
    }

    if (shakeAmt > 0.0f && targetId >= 0) {
        for (int s = 0; s < MAX_PLAYERS; s++) {
            if (!players[s].active || players[s].id != targetId) continue;
            if (shakeAmt > players[s].hitShakeAmt) {
                players[s].hitShakeAmt   = shakeAmt * 1.6f;
                players[s].hitShakeTimer = 0.22f;
            }
            break;
        }
    }

    float camShakeOffX = 0.0f, camShakeOffY = 0.0f;
    if (g_camShakeTimer > 0.0f) {
        g_camShakeTimer -= dt;
        if (g_camShakeTimer < 0.0f) {
            g_camShakeTimer = 0.0f;
            g_camShakeAmt   = 0.0f;
        } else {
            float decay = g_camShakeTimer / 0.18f;
            float amp   = g_camShakeAmt * decay * decay;
            float t     = (float)GetTime();
            camShakeOffX = amp * sinf(t * 97.3f);
            camShakeOffY = amp * sinf(t * 113.7f + 1.4f) * 0.5f;
        }
    }

    if (victory_pending || match_over) {

        float winX   = 0.0f, winY = 0.0f, winRot = 0.0f;
        bool  found  = false;
        for (int s = 0; s < MAX_PLAYERS; s++) {
            if (!players[s].active || players[s].id != winner_id) continue;
            winX   = players[s].wx;
            winY   = players[s].visualWYInit ? players[s].visualWY : players[s].wy;
            winRot = players[s].visualRotation;
            found  = true;
            break;
        }
        if (!found) { winX = camX; winY = 0.0f; winRot = 0.0f; }

        float facingX = (cosf(winRot) >= 0.0f) ? 1.0f : -1.0f;
        float dist    = 4.5f;
        float tgtCamX = winX + facingX * dist;
        float tgtCamY = winY + 0.4f;
        float tgtCamZ = 0.0f;
        float tgtFov  = 42.0f;

        float spd = 0.08f;
        camX += (tgtCamX - camX) * spd;
        camY += (tgtCamY - camY) * spd;
        camZ += (tgtCamZ - camZ) * spd;
        camTargetX += (winX          - camTargetX) * spd;
        camTargetY += ((winY + 0.5f) - camTargetY) * spd;
        camFov     += (tgtFov        - camFov)      * spd;
        camShakeOffX = 0.0f;
        camShakeOffY = 0.0f;

    } else if (is_spectator) {
        float sumX = 0.0f; int n = 0;
        for (int s = 0; s < MAX_PLAYERS; s++) {
            if (players[s].active == 1 && !players[s].respawning) { sumX += players[s].wx; n++; }
        }
        float targetX = (n > 0) ? (sumX / (float)n) : 0.0f;
        camX += (targetX - camX) * 0.05f;
        const float CAM_HALF_W = 5.0f;
        if (camX - CAM_HALF_W < STAGE_LEFT)  camX = STAGE_LEFT  + CAM_HALF_W;
        if (camX + CAM_HALF_W > STAGE_RIGHT) camX = STAGE_RIGHT - CAM_HALF_W;
        camY   = CAM_Y_DEFAULT;
        camFov = CAM_FOV_SPEC;
        camZ   = 9.0f;
    } else {
        float minX =  1e9f, maxX = -1e9f;
        float minY =  1e9f, maxY = -1e9f;
        int   n    = 0;
        for (int s = 0; s < MAX_PLAYERS; s++) {
            Player *p = &players[s];
            if (p->active != 1 || p->respawning) continue;
            if (p->wx < minX) minX = p->wx;
            if (p->wx > maxX) maxX = p->wx;
            if (p->wy < minY) minY = p->wy;
            if (p->wy > maxY) maxY = p->wy;
            n++;
        }
        if (n > 0) {
            float cx = (minX + maxX) * 0.5f;
            float cy = (minY + maxY) * 0.5f;

            float spreadX = (maxX - minX) + 4.0f;
            float spreadY = ((maxY - minY) + 3.0f) * ((float)SCREEN_W / (float)SCREEN_H);
            float spread  = spreadX > spreadY ? spreadX : spreadY;

            float t = (spread - 4.0f) / 13.0f;
            if (t < 0.0f) t = 0.0f;
            if (t > 1.0f) t = 1.0f;

            float targetFov = CAM_FOV_MIN + (CAM_FOV_MAX - CAM_FOV_MIN) * t;

            float camDist    = 9.0f;
            float halfVisReal = camDist * tanf((camFov * 0.5f) * DEG2RAD);
            float margin     = 0.8f;

            float clampedCx = cx;
            if (clampedCx - halfVisReal + margin < STAGE_LEFT)
                clampedCx = STAGE_LEFT  + halfVisReal - margin;
            if (clampedCx + halfVisReal - margin > STAGE_RIGHT)
                clampedCx = STAGE_RIGHT - halfVisReal + margin;

            float targetY = cy * 0.35f + CAM_Y_DEFAULT * 0.65f;
            if (targetY < 0.4f) targetY = 0.4f;
            if (targetY > 3.5f) targetY = 3.5f;

            camX   += (clampedCx - camX)   * 0.06f;
            camY   += (targetY   - camY)   * 0.06f;
            camFov += (targetFov - camFov) * 0.05f;
        }
        camZ = 9.0f;
    }

    int sid = g_sss.selected;
    if (sid < 0 || sid >= 4) sid = 0;
    const StageLayout *sl = &STAGE_DRAW[sid];

    if (victory_pending || match_over) {
        scene_cam.position = (Vector3){ camX,                   camY,                   camZ };
        scene_cam.target   = (Vector3){ camTargetX,             camTargetY,             0.0f };
    } else {
        scene_cam.position = (Vector3){ camX + camShakeOffX,    camY + camShakeOffY,    camZ };
        scene_cam.target   = (Vector3){ camX + camShakeOffX,    camY + camShakeOffY,    0.0f };
    }
    scene_cam.up   = (Vector3){ 0.0f, 1.0f, 0.0f };
    scene_cam.fovy = camFov;

    BeginDrawing();
    ClearBackground((Color){ 10, 10, 28, 255 });

    BeginMode3D(scene_cam);
    Skybox_Draw(scene_cam);
    EndMode3D();

    if (g_sss.selected == 3) {
        g_voidTime += dt;
        DrawDaatGrid(scene_cam);
    }

    {
        const float stageVisY = -(PLATFORM_H * 0.5f) - PLAT_MAIN_VISUAL_OFFSET;
        float groundVisW = sl->groundHw * 2.0f;
        BeginMode3D(scene_cam);
        if (g_platModelReady && g_platTexStage >= 0 && g_platTex[g_platTexStage].id > 0) {
            DrawCubeWithTex(&g_platGroundModel, (Vector3){ 0.0f, stageVisY, 0.0f }, groundVisW, PLATFORM_H, 0.6f);
            for (int pi = 0; pi < sl->platCount; pi++) {
                float pw = sl->plats[pi].hw * 2.0f;
                DrawCubeWithTex(&g_platFloatModel, (Vector3){ sl->plats[pi].cx, sl->plats[pi].cy - PLAT_VISUAL_OFFSET, 0.0f }, pw, 0.1f, 0.5f);
            }
        } else {
            DrawCube((Vector3){ 0.0f, stageVisY, 0.0f }, groundVisW, PLATFORM_H, 0.6f, (Color){ 60, 60, 90, 255 });
            for (int pi = 0; pi < sl->platCount; pi++) {
                float pw = sl->plats[pi].hw * 2.0f;
                DrawCube((Vector3){ sl->plats[pi].cx, sl->plats[pi].cy - PLAT_VISUAL_OFFSET, 0.0f }, pw, 0.1f, 0.5f, (Color){ 50, 70, 110, 255 });
            }
        }
        DrawCubeWires((Vector3){ 0.0f, stageVisY, 0.0f }, groundVisW, PLATFORM_H, 0.6f, (Color){100, 100, 160, 100});
        EndMode3D();
    }

    const float TURN_SPEED = 12.0f;

    /* Prepase de efectos: se dibujan TODOS los efectos de TODOS los
       jugadores antes que cualquier personaje. Antes el efecto de cada
       jugador se dibujaba dentro de su propia iteración del bucle, así
       que con varios jugadores activos el orden de oclusión dependía del
       slot (el último jugador del array siempre tapaba a los efectos de
       los anteriores). FxInstance guarda su propia posición de mundo en
       el momento del Fx_Trigger, así que dibujarlo aquí no depende del
       estado de animación/posición visual que se calcula más abajo. */
    BeginMode3D(scene_cam);
    for (int s = 0; s < MAX_PLAYERS; s++) {
        Player *p = &players[s];
        if (!p->active || p->active != 1 || !p->character || p->respawning) continue;
        if (is_spectator && my_id > 0 && p->id == my_id) continue;
        if ((victory_pending || match_over) && p->id != winner_id) continue;
        Fx_Update(&p->fx, dt);
        Fx_Draw(&p->fx, scene_cam);
    }
    EndMode3D();

    for (int s = 0; s < MAX_PLAYERS; s++) {
        Player *p = &players[s];
        if (!p->active) { p->prevRespawning = false; continue; }

        if (p->prevRespawning && !p->respawning && !victory_pending && !match_over) {
            p->outlineTimer = 3.5f;
            if (p->id == my_id) p->youTimer = 4.5f;
        }
        p->prevRespawning = p->respawning;
        if (p->outlineTimer > 0.0f) p->outlineTimer -= dt;
        if (p->youTimer    > 0.0f) p->youTimer    -= dt;

        if (p->active != 1 || !p->character || p->respawning) continue;
        if (is_spectator && my_id > 0 && p->id == my_id) continue;

        if ((victory_pending || match_over) && p->id != winner_id) continue;

        if (p->character->currentFrame < 0 ||
                p->character->currentFrame >= p->character->animation.frameCount) {
            p->character->currentFrame = 0;
            p->character->forceUpdate  = true;
        }

        UpdateAnimatedCharacter(p->character, animDt);
        if (p->character->animController && !p->character->animController->playing) {
            if (victory_pending && p->id == winner_id) {

                victory_msg_delay = 0.6f;
                int last = p->character->animation.frameCount - 1;
                if (last < 0) last = 0;
                p->character->currentFrame = last;
                p->character->forceUpdate  = true;
                SetCharacterAutoPlay(p->character, false);
            } else if (match_over && p->id == winner_id) {
                int last = p->character->animation.frameCount - 1;
                if (last < 0) last = 0;
                p->character->currentFrame = last;
                p->character->forceUpdate  = true;
                SetCharacterAutoPlay(p->character, false);
            } else if (p->animIndex == AnimIndex("crouch") || p->animIndex == AnimIndex("jump")) {
                int last = p->character->animation.frameCount - 1;
                if (last < 0) last = 0;
                p->character->currentFrame = last;
                p->character->forceUpdate  = true;
                SetCharacterAutoPlay(p->character, false);
            } else if (p->animIndex != AnimIndex("idle")) {
                strcpy_safe(p->animation, "idle", sizeof(p->animation));
                p->animIndex = AnimIndex("idle");
                LoadPlayerAnim(p, 0);
                SetCharacterAutoPlay(p->character, true);
            }
        }

        if (p->character->autoCenterCalculated) {
            p->character->autoCenter.x = 0.0f;
            p->character->autoCenter.z = 0.0f;
        }

        {
            float target = p->rotation;
            float cur    = p->visualRotation;
            float diff   = target - cur;
            while (diff >  (float)M_PI) diff -= 2.0f * (float)M_PI;
            while (diff < -(float)M_PI) diff += 2.0f * (float)M_PI;
            float step = TURN_SPEED * dt;
            p->visualRotation = (fabsf(diff) <= step) ? target : cur + (diff > 0 ? step : -step);
        }

        if (p->victoryLanding) {
            if (!p->visualWYInit) {
                p->visualWY     = p->wy;
                p->visualWYInit = true;
                p->victoryFallVY = 0.0f;
            }
            float targetY = p->victoryLandingTargetY;
            if (p->visualWY > targetY + 0.01f) {
                const float GRAVITY = 18.0f;
                p->victoryFallVY -= GRAVITY * dt;
                p->visualWY      += p->victoryFallVY * dt;
                if (p->visualWY < targetY) p->visualWY = targetY;
            } else {
                p->visualWY       = targetY;
                p->victoryLanding = false;
                int vi = AnimIndex("victory");
                LoadPlayerAnim(p, vi);
                SetCharacterAutoPlay(p->character, true);
                p->character->currentFrame = 0;
                p->character->forceUpdate  = true;
                p->animIndex = vi;
                strcpy_safe(p->animation, ANIM_NAME[vi], sizeof(p->animation));
            }
        } else if (!p->visualWYInit) {
            p->visualWY     = p->wy;
            p->visualWYInit = true;
        } else if (!victory_pending && !match_over) {
            p->visualWY = p->wy;
        }

        bool isWinner = (victory_pending || match_over) && p->id == winner_id;
        float victoryRaise = (isWinner && !p->victoryLanding) ? 0.07f : 0.0f;
        float visualY = (p->victoryLanding || isWinner)
                        ? (p->visualWY - (p->hasAnchorY ? p->anchorYOffset : 0.0f) + victoryRaise)
                        : (p->wy       - (p->hasAnchorY ? p->anchorYOffset : 0.0f));

        float playerShakeX = 0.0f, playerShakeY = 0.0f;
        if (p->hitShakeTimer > 0.0f) {
            p->hitShakeTimer -= dt;
            if (p->hitShakeTimer < 0.0f) {
                p->hitShakeTimer = 0.0f;
                p->hitShakeAmt   = 0.0f;
            } else {
                float decay = p->hitShakeTimer / 0.22f;
                float amp   = p->hitShakeAmt * decay * decay;
                float t     = (float)GetTime();
                playerShakeX = amp * sinf(t * 141.2f + (float)p->id * 2.3f);
                playerShakeY = amp * sinf(t * 127.8f + (float)p->id * 3.7f) * 0.4f;
            }
        }

        Vector3 worldPos = { p->wx + playerShakeX, visualY + playerShakeY, 0.0f };
        float   drawRot  = p->visualRotation + (float)M_PI_2;

        bool doOutline = (g_shdrOutline.id > 0 && p->outlineTimer > 0.0f && p->id != my_id);

        Color tintCol;
        bool  shouldTint = PlayerClothTintColor(p, &tintCol);
        if (p->character && p->character->clothPanels &&
                p->character->clothPanels->loaded) {
            ClothSystem *cs = p->character->clothPanels;
            for (int _ci = 0; _ci < cs->panelCount; _ci++)
                cs->panels[_ci].color = shouldTint ? tintCol : cs->panels[_ci].baseColor;
        }
        if (p->character && p->character->waistCloths &&
                p->character->waistCloths->loaded) {
            WaistClothSystem *wcs = p->character->waistCloths;
            for (int _wi = 0; _wi < wcs->clothCount; _wi++) {
                WaistCloth *wc = &wcs->cloths[_wi];
                wc->color       = shouldTint ? tintCol : wc->baseColor;
                wc->colorInside = shouldTint ? tintCol : wc->baseColorInside;
            }
        }

        ClothSystem      *clothToRedraw      = NULL;
        WaistClothSystem *waistClothToRedraw = NULL;
        Vector3      clothWorldPos = {0};
        Matrix       clothWorldRot = MatrixIdentity();
        Vector3      clothWorldPiv = {0};
        if (doOutline && p->character && p->character->clothPanels &&
                p->character->clothPanels->loaded) {
            clothToRedraw = p->character->clothPanels;
            clothWorldPos = p->character->worldPosition;
            clothWorldRot = MatrixRotateY(p->character->worldRotation);
            clothWorldPiv = p->character->worldPivot;
            for (int _ci = 0; _ci < clothToRedraw->panelCount; _ci++)
                clothToRedraw->panels[_ci].visible = false;
        }
        if (doOutline && p->character && p->character->waistCloths &&
                p->character->waistCloths->loaded) {
            waistClothToRedraw = p->character->waistCloths;
            clothWorldPos = p->character->worldPosition;
            clothWorldRot = MatrixRotateY(p->character->worldRotation);
            clothWorldPiv = p->character->worldPivot;
            for (int _wi = 0; _wi < waistClothToRedraw->clothCount; _wi++)
                waistClothToRedraw->cloths[_wi].visible = false;
        }
        if (doOutline) {
            int   ci  = PlayerColorIndex(p);
            Color oc  = PLAYER_COLORS[ci];
            float alpha = (p->outlineTimer < 1.0f) ? p->outlineTimer : 1.0f;
            float col[4] = { oc.r/255.0f, oc.g/255.0f, oc.b/255.0f, alpha };
            float tsz[2] = { 512.0f, 512.0f };
            if (p->character->renderer && p->character->renderer->textureCount > 0 &&
                p->character->renderer->textures[0].id > 0) {
                tsz[0] = (float)p->character->renderer->textures[0].width;
                tsz[1] = (float)p->character->renderer->textures[0].height;
            }
            float sz = 9.0f;
            SetShaderValue(g_shdrOutline, g_outlineSizeLoc,  &sz,  SHADER_UNIFORM_FLOAT);
            SetShaderValue(g_shdrOutline, g_outlineColorLoc,  col,  SHADER_UNIFORM_VEC4);
            SetShaderValue(g_shdrOutline, g_textureSizeLoc,   tsz,  SHADER_UNIFORM_VEC2);
            BeginShaderMode(g_shdrOutline);
        }
        DrawAnimatedCharacterTransformed(p->character, scene_cam, worldPos, drawRot);
        if (doOutline) EndShaderMode();

        if (clothToRedraw || waistClothToRedraw) {
            if (clothToRedraw)
                for (int _ci = 0; _ci < clothToRedraw->panelCount; _ci++)
                    clothToRedraw->panels[_ci].visible = true;
            if (waistClothToRedraw)
                for (int _wi = 0; _wi < waistClothToRedraw->clothCount; _wi++)
                    waistClothToRedraw->cloths[_wi].visible = true;

            /* Igual que el camino principal de dibujo: cada celda de cloth se
               recolecta como un DrawableQuad con su propia profundidad de
               cámara y se ordena junto con el resto, en vez del viejo
               sándwich de 2 pasadas (behindOnly) que comparaba un único punto
               de referencia por panel contra el centro del personaje. Ese
               método fallaba con paneles grandes o ángulos de cámara donde
               una parte del panel queda delante y otra detrás del cuerpo,
               haciendo que el panel completo "saltara" entero a la pasada
               equivocada mientras el personaje se movía. */
            static DrawableQuad redrawQuads[MAX_DRAWABLE_QUADS];
            int redrawQuadCount = 0;
            if (clothToRedraw)
                Cloth_Collect(clothToRedraw, scene_cam, clothWorldPos, clothWorldRot,
                              clothWorldPiv, redrawQuads, &redrawQuadCount, MAX_DRAWABLE_QUADS);
            if (waistClothToRedraw)
                WaistCloth_Collect(waistClothToRedraw, scene_cam, clothWorldPos, clothWorldRot,
                                    clothWorldPiv, redrawQuads, &redrawQuadCount, MAX_DRAWABLE_QUADS);

            for (int i = 0; i < redrawQuadCount - 1; i++) {
                bool swapped = false;
                for (int j = 0; j < redrawQuadCount - i - 1; j++) {
                    if (redrawQuads[j].depth < redrawQuads[j + 1].depth) {
                        DrawableQuad t      = redrawQuads[j];
                        redrawQuads[j]      = redrawQuads[j + 1];
                        redrawQuads[j + 1]  = t;
                        swapped = true;
                    }
                }
                if (!swapped) break;
            }

            BeginMode3D(scene_cam);
            BeginBlendMode(BLEND_ALPHA_PREMULTIPLY);
            rlDisableBackfaceCulling();
            rlDisableDepthMask();
            for (int i = 0; i < redrawQuadCount; i++)
                DrawableQuad_Draw(&redrawQuads[i]);
            rlEnableDepthMask();
            rlEnableBackfaceCulling();
            EndBlendMode();
            EndMode3D();
        }

        if (p->id == my_id && p->youTimer > 0.0f) {
            float alpha = (p->youTimer < 1.0f) ? p->youTimer : 1.0f;
            unsigned char a = (unsigned char)(alpha * 255.0f);

            bool showBlink = true;
            if (p->youTimer < 1.0f) showBlink = ((int)(p->youTimer * 8.0f) % 2 == 0);
            if (showBlink) {

                Vector2 screenPos = GetWorldToScreen(
                    (Vector3){ worldPos.x, worldPos.y + 1.6f, worldPos.z }, scene_cam);
                const char *youTxt = "YOU";
                int  fontSize = 28;
                int  tw = MeasureText(youTxt, fontSize);
                int  sx = (int)screenPos.x - tw / 2;
                int  sy = (int)screenPos.y ;

                DrawText(youTxt, sx+1, sy+1, fontSize, (Color){0,0,0,a});
                DrawText(youTxt, sx,   sy,   fontSize, (Color){80,180,255,a});

                int arrowY = sy + fontSize + 2;
                DrawText("v", (int)screenPos.x - 4, arrowY, fontSize, (Color){80,180,255,a});
            }
        }
    }

    if (IsKeyPressed(KEY_U)) debug_mode = !debug_mode;
    if (debug_mode) {
        BeginMode3D(scene_cam);
        DrawCubeWires((Vector3){ 0.0f, -(PLATFORM_H * 0.5f), 0.0f }, sl->groundHw * 2.0f, 0.05f, 0.1f, (Color){  0, 200, 255, 160 });
        for (int pi = 0; pi < sl->platCount; pi++)
            DrawCubeWires((Vector3){ sl->plats[pi].cx, sl->plats[pi].cy, 0.0f },
                          sl->plats[pi].hw * 2.0f, 0.05f, 0.1f, (Color){  0, 200, 255, 160 });
        DrawLine3D((Vector3){-8.0f, -6.0f, 0}, (Vector3){-8.0f, 4.0f, 0}, (Color){255,  60,  60, 180 });
        DrawLine3D((Vector3){ 8.0f, -6.0f, 0}, (Vector3){ 8.0f, 4.0f, 0}, (Color){255,  60,  60, 180 });
        DrawLine3D((Vector3){-10.f, -6.0f, 0}, (Vector3){10.0f,-6.0f, 0}, (Color){255,  60,  60, 180 });

        for (int s = 0; s < MAX_PLAYERS; s++) {
            Player *p = &players[s];
            if (p->active != 1 || p->respawning) continue;
            if (is_spectator && my_id > 0 && p->id == my_id) continue;
            Vector3 wp = { p->wx, p->wy, 0.0f };
            Color   cc = (p->id == my_id) ? (Color){0,255,100,220} : (Color){255,80,80,220};
            DrawCubeWires((Vector3){ wp.x, wp.y + 0.36f, 0.0f }, 0.48f, 0.72f, 0.05f, cc);
            DrawSphere(wp, 0.06f, cc);
            if (p->attackFlashTimer > 0.0f) {
                p->attackFlashTimer -= dt;
                if (p->attackFlashTimer > 0.0f) {
                    DrawCubeWires(
                        (Vector3){ wp.x + p->attackFlashFacing * (ATTACK_RANGE * 0.5f), wp.y + 0.5f, 0.0f },
                        ATTACK_RANGE, ATTACK_RANGE_Y, 0.05f, (Color){255,255,0,220});
                }
            }
        }
        EndMode3D();
    }

    blinkTimer += dt;
    if (blinkTimer > 0.18f) { blinkTimer = 0.0f; blinkOn = !blinkOn; }

    HUD_LoadTextures();

    Player *myPlayer = NULL;
    Player *enemies[MAX_PLAYERS];
    int     enemyCount = 0;

    for (int s = 0; s < MAX_PLAYERS; s++) {
        Player *p = &players[s];
        if (!p->active) continue;
        if (!is_spectator && p->id == my_id) {
            myPlayer = p;
        } else {
            enemies[enemyCount++] = p;
        }
    }

    if (is_spectator) {
        myPlayer = NULL;
        enemyCount = 0;
        for (int s = 0; s < MAX_PLAYERS; s++) {
            if (players[s].active) enemies[enemyCount++] = &players[s];
        }
    }

    int mySize = (int)(SCREEN_H * 0.17f);
    if (mySize < 100) mySize = 100;
    if (mySize > 200) mySize = 200;

    int enemySize;
    if (enemyCount <= 1) {
        enemySize = mySize;
    } else if (enemyCount <= 3) {
        enemySize = (int)(mySize * 0.65f);
    } else {
        enemySize = (int)(mySize * 0.50f);
    }
    if (enemySize < 52) enemySize = 52;

    if (myPlayer) {
        int margin = (int)(mySize * 0.10f); if (margin < 8) margin = 8;
        int cx = margin + mySize / 2;
        int cy = margin + mySize / 2;
        int ci = CharIndexOf(myPlayer->charId);
        DrawPortraitWidget(cx, cy, mySize,
                           ci, myPlayer->id,
                           myPlayer->voltage, myPlayer->voltageMaxed, blinkOn,
                           myPlayer->stocks, true);

        const char *nm = myPlayer->username[0] ? myPlayer->username : "Tú";
        int nameSz = (int)(mySize * 0.11f); if (nameSz < 10) nameSz = 10;
        int dotRow = cy + mySize/2 + (int)(mySize*0.06f) + 4 + (int)(mySize*0.06f)*2 + 4;
        DrawText(nm, cx - MeasureText(nm, nameSz)/2, dotRow + 2, nameSz, YELLOW);
    }

    if (enemyCount > 0) {
        int eMargin = (int)(enemySize * 0.10f); if (eMargin < 6) eMargin = 6;
        int gap     = (int)(enemySize * 0.12f); if (gap < 4) gap = 4;

        int cols, rows;
        if (enemyCount <= 4) { cols = enemyCount; rows = 1; }
        else                 { cols = 4;          rows = 2; }

        int totalW = cols * enemySize + (cols - 1) * gap;
        int totalH = rows * enemySize + (rows - 1) * gap;

        int stockDotExtra = (int)(enemySize * 0.06f) * 2 + 8;

        int startX = SCREEN_W - eMargin - totalW + enemySize / 2;
        int startY = SCREEN_H - eMargin - stockDotExtra - totalH + enemySize / 2;

        for (int e = 0; e < enemyCount; e++) {
            Player *ep = enemies[e];
            int row = e / cols;
            int col = e % cols;
            int ecx = startX + col * (enemySize + gap);
            int ecy = startY + row * (enemySize + gap);
            int ci  = CharIndexOf(ep->charId);
            DrawPortraitWidget(ecx, ecy, enemySize,
                               ci, ep->id,
                               ep->voltage, ep->voltageMaxed, blinkOn,
                               ep->stocks, false);
        }
    }

    if (is_spectator) {
        DrawText("SPECTATOR", SCREEN_W - 90, 8, 12, (Color){80,200,255,255});
    } else if (my_id <= 0) {
        if (no_id_frames > 60) {
            DrawText("Connecting...", SCREEN_W - 100, 8, 12, (Color){220,140,40,255});
            if (ws_player_count() > 0)
                DrawText("Waiting for server...", SCREEN_W / 2 - 80, SCREEN_H / 2, 16,
                         (Color){200,200,200,180});
        } else {
            DrawText("Connecting...", SCREEN_W - 100, 8, 12, (Color){220,140,40,255});
        }
    }

    if (victory_pending && winner_message[0] != '\0') {
        const bool iWon2 = (!is_spectator && my_id == winner_id);
        if (iWon2) {
            static float vt = 0.0f;
            vt += GetFrameTime() * 2.5f;
            unsigned char va = (unsigned char)(180 + 75 * sinf(vt));
            const char *vtxt = "VICTORY!";
            int vsz = 52;
            int vw  = MeasureText(vtxt, vsz);
            DrawText(vtxt, (SCREEN_W - vw) / 2, SCREEN_H / 5, vsz, (Color){255,215,0,va});
        }
    }

    if (match_over && winner_message[0] != '\0') {
        const bool iWon = (!is_spectator && my_id == winner_id);

        DrawRectangle(0, 0, SCREEN_W, SCREEN_H, (Color){0,0,0,180});

        const int BOX_W = 420;
        const int BOX_H = iWon ? 160 : 130;
        const int BOX_X = (SCREEN_W - BOX_W) / 2;
        const int BOX_Y = (SCREEN_H - BOX_H) / 2;

        Color borderCol = iWon ? (Color){255,215,0,255}  : (Color){80,200,255,255};
        Color bgCol     = iWon ? (Color){40,30,0,240}    : (Color){20,20,40,240};

        DrawRectangle    (BOX_X, BOX_Y, BOX_W, BOX_H, bgCol);
        DrawRectangleLines(BOX_X, BOX_Y, BOX_W, BOX_H, borderCol);
        DrawRectangleLines(BOX_X+2, BOX_Y+2, BOX_W-4, BOX_H-4,
                           (Color){borderCol.r, borderCol.g, borderCol.b, 120});

        if (iWon) {
            const char *line1 = "*** VICTORY ***";
            int l1w = MeasureText(line1, 36);
            DrawText(line1, BOX_X + (BOX_W - l1w) / 2, BOX_Y + 16, 36, (Color){255,215,0,255});

            const char *line2 = "¡Eres el último en pie!";
            int l2w = MeasureText(line2, 18);
            DrawText(line2, BOX_X + (BOX_W - l2w) / 2, BOX_Y + 64, 18, WHITE);

            static float blinkV = 0.0f;
            blinkV += GetFrameTime() * 3.0f;
            unsigned char alpha = (unsigned char)(180 + 75 * sinf(blinkV));
            const char *line3 = "Recarga la página para volver a jugar";
            int l3w = MeasureText(line3, 14);
            DrawText(line3, BOX_X + (BOX_W - l3w) / 2, BOX_Y + 100, 14, (Color){255,215,0,alpha});

            const char *line4 = "(F5 / Ctrl+R)";
            int l4w = MeasureText(line4, 12);
            DrawText(line4, BOX_X + (BOX_W - l4w) / 2, BOX_Y + 120, 12, (Color){200,180,80,180});
        } else {
            bool isDefeated = (strcmp(winner_message, "DERROTA") == 0);
            const char *line1 = isDefeated ? "DERROTA" : "FIN DE LA PARTIDA";
            int fsize1        = isDefeated ? 34 : 26;
            int l1w = MeasureText(line1, fsize1);
            DrawText(line1, BOX_X + (BOX_W - l1w) / 2, BOX_Y + 16, fsize1, (Color){80,200,255,255});

            char wline[80];
            const Player *winnerP = NULL;
            for (int s = 0; s < MAX_PLAYERS; s++)
                if (players[s].active && players[s].id == winner_id) { winnerP = &players[s]; break; }
            if (winnerP && winnerP->username[0])
                snprintf(wline, sizeof(wline), "Ganador: %s", winnerP->username);
            else
                snprintf(wline, sizeof(wline), "Ganador: Player %d", winner_id);
            int wlw = MeasureText(wline, 18);
            DrawText(wline, BOX_X + (BOX_W - wlw) / 2, BOX_Y + 62, 18, YELLOW);

            const char *line3 = "Recarga para jugar la próxima partida";
            int l3w = MeasureText(line3, 13);
            DrawText(line3, BOX_X + (BOX_W - l3w) / 2, BOX_Y + 96, 13, (Color){160,160,160,200});
        }
    }

    if (!match_over) {
        int   cd_phase   = ws_get_countdown();
        float cd_elapsed = ws_get_countdown_elapsed();

        if (cd_phase == 1 || cd_phase == 2) {
            float phase_t = (cd_phase == 1)
                ? (cd_elapsed / 1.2f)
                : ((cd_elapsed - 1.2f) / 1.0f);
            if (phase_t > 1.0f) phase_t = 1.0f;

            const char *word = (cd_phase == 1) ? "READY?" : "FIGHT!";

            float scale = 1.0f + 0.6f * (1.0f - phase_t);
            float fade  = (phase_t > 0.7f) ? (1.0f - (phase_t - 0.7f) / 0.3f) : 1.0f;
            if (fade < 0.0f) fade = 0.0f;
            unsigned char alpha = (unsigned char)(255.0f * fade);

            int size = (int)(64.0f * scale);
            int tw   = MeasureText(word, size);
            int tx   = (SCREEN_W - tw) / 2;
            int ty   = SCREEN_H / 2 - size / 2 - 30;

            DrawText(word, tx + 4, ty + 4, size, (Color){0,0,0,(unsigned char)(alpha/2)});
            Color wordCol = (cd_phase == 1) ? (Color){255,240,80,alpha} : (Color){255,60,30,alpha};
            DrawText(word, tx, ty, size, wordCol);
        }
    }

    EndDrawing();
}

static void CSS_LoadPortraits(void) {
    if (g_css.portraitsLoaded) return;
    for (int i = 0; i < CHARS_SELECTABLE; i++) g_css.portraits[i] = LoadTexture(CHARS[i].portrait);
    g_css.portraitsLoaded = true;
}

static void CSS_UnloadPortraits(void) {
    if (!g_css.portraitsLoaded) return;
    for (int i = 0; i < CHARS_SELECTABLE; i++) UnloadTexture(g_css.portraits[i]);
    g_css.portraitsLoaded = false;
}

static bool CSS_UpdateAndDraw(void) {
    if (g_css.phase == CSS_SELECTING && !g_css.savedCharId[0]) {
        char saved[32] = {0};
        if (ws_get_saved_char_id(saved, sizeof(saved)) && saved[0]) {
            strncpy(g_css.savedCharId, saved, sizeof(g_css.savedCharId)-1);
            for (int i = 0; i < CHARS_SELECTABLE; i++) {
                if (strcmp(CHARS[i].charId, saved) == 0) { g_css.selected = i; break; }
            }
            ws_send_char_select(saved, g_css.selected >= 0 ? g_css.selected : 0, 0);
            g_css.phase = CSS_WAITING_ACK;
        }
    }

    if (g_css.phase == CSS_WAITING_ACK && ws_char_select_ready()) {
        for (int s = 0; s < MAX_PLAYERS; s++) {
            if (players[s].active && players[s].id == my_id) {
                if (g_css.selected >= 0)
                    strncpy(players[s].charId, CHARS[g_css.selected].charId, sizeof(players[s].charId)-1);
                else if (g_css.savedCharId[0])
                    strncpy(players[s].charId, g_css.savedCharId, sizeof(players[s].charId)-1);
                break;
            }
        }
        g_css.phase = CSS_DONE;
        CSS_UnloadPortraits();
        return true;
    }

    if (g_css.phase == CSS_WAITING_GAME) {
        if (ws_match_started()) {
            for (int s = 0; s < MAX_PLAYERS; s++) {
                if (players[s].active && players[s].id == my_id) {
                    if (g_css.selected >= 0)
                        strncpy(players[s].charId, CHARS[g_css.selected].charId, sizeof(players[s].charId)-1);
                    else if (g_css.savedCharId[0])
                        strncpy(players[s].charId, g_css.savedCharId, sizeof(players[s].charId)-1);
                    break;
                }
            }
            g_css.phase = CSS_DONE;
            CSS_UnloadPortraits();
            return true;
        }

        {
            ClearBackground((Color){10,10,20,255});
            const char *sel = (g_css.selected >= 0) ? CHARS[g_css.selected].name
                                                     : (g_css.savedCharId[0] ? g_css.savedCharId : "?");
            char line[64];
            snprintf(line, sizeof(line), "Listo: %s", sel);
            int sw2 = GetScreenWidth(), sh2 = GetScreenHeight();
            DrawText(line, (sw2 - MeasureText(line, 28)) / 2, sh2/2, 28, GOLD);
        }
        return false;
    }

    CSS_LoadPortraits();

    int sw = GetScreenWidth(), sh = GetScreenHeight();
    ClearBackground((Color){10,10,20,255});

    const char *title = (g_css.phase == CSS_WAITING_ACK)
                      ? "Confirmando seleccion..."
                      : "Elige tu personaje";

    int cardW  = (int)(sw * 0.88f / 4.15f);
    if (cardW < 120) cardW = 120;
    if (cardW > 380) cardW = 380;
    int labelH = (int)(cardW * 0.20f); if (labelH < 26) labelH = 26;
    int cardH  = (int)(cardW * (1280.0f / 720.0f)) + labelH;
    int gap    = (int)(cardW * 0.05f); if (gap < 8) gap = 8;

    int titleSz = (int)(sw * 0.038f); if (titleSz < 24) titleSz = 24; if (titleSz > 64) titleSz = 64;
    int nameSz  = (int)(sw * 0.020f); if (nameSz  < 15) nameSz  = 15; if (nameSz  > 36) nameSz  = 36;
    int hintSz  = (int)(sw * 0.015f); if (hintSz  < 12) hintSz  = 12; if (hintSz  > 26) hintSz  = 26;

    int titleY = (int)(sh * 0.04f);
    DrawText(title, (sw - MeasureText(title, titleSz)) / 2, titleY, titleSz, WHITE);

    int totalW    = CHARS_SELECTABLE * cardW + (CHARS_SELECTABLE - 1) * gap;
    int startX    = (sw - totalW) / 2;
    int hintAreaH = hintSz + (int)(sh * 0.05f);
    int availH    = sh - (titleY + titleSz + (int)(sh * 0.02f)) - hintAreaH;
    int startY    = (titleY + titleSz + (int)(sh * 0.02f)) + (availH - cardH) / 2;
    int bottomLimit = sh - hintAreaH - 4;
    if (startY + cardH > bottomLimit) startY = bottomLimit - cardH;
    if (startY < titleY + titleSz + 8) startY = titleY + titleSz + 8;

    Vector2 mouse = GetMousePosition();
    if (g_css.phase == CSS_SELECTING) {
        for (int i = 0; i < CHARS_SELECTABLE; i++) {
            Rectangle card = { startX + i*(cardW+gap), startY, cardW, cardH };
            if (CheckCollisionPointRec(mouse, card)) g_css.hovered = i;
        }
        if (IsKeyPressed(KEY_LEFT)  || IsKeyPressed(KEY_A)) g_css.hovered = (g_css.hovered + CHARS_SELECTABLE - 1) % CHARS_SELECTABLE;
        if (IsKeyPressed(KEY_RIGHT) || IsKeyPressed(KEY_D)) g_css.hovered = (g_css.hovered + 1) % CHARS_SELECTABLE;
    }

    for (int i = 0; i < CHARS_SELECTABLE; i++) {
        Rectangle card  = { startX + i*(cardW+gap), startY, cardW, cardH };
        bool hover  = (g_css.phase == CSS_SELECTING && i == g_css.hovered);
        bool chosen = (i == g_css.selected);
        Color border = chosen ? GOLD : (hover ? WHITE : (Color){80,80,80,255});
        Color bg     = chosen ? (Color){40,30,10,255} : (hover ? (Color){30,30,50,255} : (Color){20,20,35,255});
        DrawRectangleRec(card, bg);
        DrawRectangleLinesEx(card, chosen ? 3.0f : 2.0f, border);

        Texture2D tex = g_css.portraits[i];
        int portraitAreaH = cardH - labelH;
        if (tex.id > 0) {
            float scaleW = (float)(cardW - 4) / tex.width;
            float scaleH = (float)(portraitAreaH - 4) / tex.height;
            float scale  = (scaleW < scaleH) ? scaleW : scaleH;
            int   pw     = (int)(tex.width  * scale);
            int   ph     = (int)(tex.height * scale);
            int   px     = card.x + (cardW - pw) / 2;
            int   py     = card.y + (portraitAreaH - ph) / 2;
            DrawTexturePro(tex, (Rectangle){0,0,tex.width,tex.height},
                           (Rectangle){px,py,pw,ph}, (Vector2){0,0}, 0.0f, WHITE);
        }

        const char *nm = CHARS[i].name;
        int nmY = card.y + cardH - labelH + (labelH - nameSz) / 2;
        DrawText(nm, card.x + (cardW - MeasureText(nm, nameSz)) / 2, nmY, nameSz, border);

        if (chosen && g_css.phase == CSS_WAITING_ACK) {
            g_css.confirmTimer += GetFrameTime();
            if ((int)(g_css.confirmTimer * 4) % 2 == 0)
                DrawRectangleLinesEx(card, 4.0f, GOLD);
        }
    }

    if (g_css.phase == CSS_SELECTING) {
        const char *hint = "Click o ENTER para confirmar";
        DrawText(hint, (sw - MeasureText(hint, hintSz)) / 2, sh - (int)(sh * 0.05f), hintSz, GRAY);

        Rectangle hcard = { startX + g_css.hovered*(cardW+gap), startY, cardW, cardH };
        bool click = IsMouseButtonPressed(MOUSE_LEFT_BUTTON) && CheckCollisionPointRec(mouse, hcard);
        bool enter = IsKeyPressed(KEY_ENTER) || IsKeyPressed(KEY_SPACE);
        if (click || enter) {
            g_css.selected     = g_css.hovered;
            g_css.confirmTimer = 0.0f;
            g_css.phase        = CSS_WAITING_ACK;
            ws_send_char_select(CHARS[g_css.selected].charId, g_css.selected, STAGES[g_sss.selected].id);
        }
    }

    return false;
}

static void ws_reset_screens(void) {

    SSS_UnloadPreviews();
    g_sss.phase         = SSS_SELECTING;
    g_sss.hovered       = 0;
    g_sss.selected      = 0;
    g_sss.isHost        = false;

    CSS_UnloadPortraits();
    g_css.phase         = CSS_SELECTING;
    g_css.hovered       = 0;
    g_css.selected      = -1;
    g_css.portraitsLoaded = false;
    g_css.savedCharId[0] = '\0';

    ws_clear_char_select();
}

static void MainLoop(void) {
    if (!game_ready) return;

    if (ws_needs_screen_reset()) {
        ws_reset_screens();
        return;
    }

    {
        int newW = js_canvas_width();
        int newH = js_canvas_height();
        if (newW > 0 && newH > 0 && (newW != SCREEN_W || newH != SCREEN_H)) {
            SCREEN_W = newW;
            SCREEN_H = newH;
            SetWindowSize(SCREEN_W, SCREEN_H);
        }
    }

    if (g_css.phase != CSS_DONE && ws_is_spectator()) {
        CSS_UnloadPortraits();
        g_css.phase = CSS_DONE;
    }

    if (g_sss.phase != SSS_DONE) {
        if (ws_is_spectator()) {
            int confirmed = ws_get_confirmed_stage();
            if (confirmed >= 0) {
                for (int i = 0; i < STAGES_COUNT; i++) {
                    if (STAGES[i].id == confirmed) { g_sss.selected = i; break; }
                }
            }
            g_sss.phase = SSS_DONE;
        } else {
            FetchState();
            BeginDrawing();
            bool sss_done = SSS_UpdateAndDraw();
            EndDrawing();
            if (!sss_done) return;
        }
    }

    if (g_css.phase != CSS_DONE) {
        FetchState();
        BeginDrawing();
        CSS_UpdateAndDraw();
        EndDrawing();
        return;
    }

    static bool post_css_reinit_done = false;
    if (!post_css_reinit_done) {
        post_css_reinit_done = true;
        for (int s = 0; s < MAX_PLAYERS; s++) {
            if (players[s].active) {
                char cid[32] = {0};
                if (ws_get_player_char_id_by_client(players[s].id, cid, sizeof(cid)) && cid[0])
                    strncpy(players[s].charId, cid, sizeof(players[s].charId)-1);
                if (players[s].character) {
                    DestroyAnimatedCharacter(players[s].character);
                    players[s].character = NULL;
                }
                players[s].active             = 2;
                players[s].hasReferenceCenter = false;
                players[s].hasAnchorY         = false;
                QueuePlayerInit(players[s].id);
            }
        }
        while (pending_count > 0) FlushOnePlayerInit();
    }

    is_spectator = (bool)ws_is_spectator();

    if (is_spectator) {
        my_id        = -1;
        no_id_frames = 0;
    } else if (my_id > 0) {
        no_id_frames = 0;
    } else {
        my_id = ws_get_my_id();
        if (my_id > 0) {
            ATTACK_RANGE   = ws_get_attack_range();
            ATTACK_RANGE_Y = ws_get_attack_range_y();
            no_id_frames   = 0;
        } else {
            no_id_frames++;
            if (no_id_frames >= NO_ID_SPECTATOR_FRAMES && ws_player_count() > 0) {
                is_spectator = true;
                my_id        = -1;
            }
        }
    }

    FetchState();
    FlushOnePlayerInit();

    if (!is_spectator && my_id > 0) {
        static void *fight_ready_for_character = NULL;
        for (int s = 0; s < MAX_PLAYERS; s++) {
            if (players[s].active && players[s].id == my_id) {
                if (players[s].character && players[s].character != fight_ready_for_character) {
                    fight_ready_for_character = players[s].character;
                    ws_send_fight_ready();
                }
                break;
            }
        }
    }

    if (!match_over && !victory_pending) {
        int vstate = ws_get_victory_state();
        if (vstate != 0) {
            int wid         = ws_get_victory_winner();
            victory_pending   = true;
            winner_id         = wid;
            victory_msg_delay = VICTORY_MSG_DELAY;

            for (int s = 0; s < MAX_PLAYERS; s++) {
                players[s].outlineTimer = 0.0f;
                players[s].youTimer     = 0.0f;
            }

            snprintf(winner_message, sizeof(winner_message),
                     (vstate == 1) ? "VICTORY" : "DERROTA");

            for (int s = 0; s < MAX_PLAYERS; s++) {
                if (!players[s].active || players[s].id != winner_id) continue;

                players[s].visualWY              = players[s].wy;
                players[s].visualWYInit          = true;
                players[s].victoryFallVY         = 0.0f;
                players[s].victoryLanding        = true;
                players[s].victoryLandingTargetY = FindLandingY(players[s].wx, players[s].wy);
                break;
            }
        }
    }

    if (!match_over && victory_pending) {
        if (victory_msg_delay > 0.0f) {
            victory_msg_delay -= GetFrameTime();
        } else if (ws_overlay_ready()) {
            match_over      = true;
            victory_pending = false;
            ws_consume_victory();
        }
    }

    DrawGame();
}

int main(void) {
    memset(players, 0, sizeof(players));

    SetTraceLogLevel(LOG_ERROR);
    InitWindow(SCREEN_W, SCREEN_H, "Enuma Fighter");
    SetTargetFPS(0);

    scene_cam = (Camera){
        .position   = { 0.0f, CAM_Y_DEFAULT, 9.0f },
        .target     = { 0.0f, CAM_Y_DEFAULT, 0.0f },
        .up         = { 0.0f, 1.0f, 0.0f },
        .fovy       = CAM_FOV_SPEC,
        .projection = CAMERA_PERSPECTIVE,
    };

    game_ready = true;

    Fx_LoadTextures();

    {

        Mesh mg = GenMeshCube(1.0f, 1.0f, 1.0f);
        TileUVs(&mg, 10.0f, 0.2f);
        g_platGroundModel = LoadModelFromMesh(mg);

        Mesh mf = GenMeshCube(1.0f, 1.0f, 1.0f);
        TileUVs(&mf, 2.0f, 0.2f);
        g_platFloatModel = LoadModelFromMesh(mf);

        g_platModelReady = true;
    }

    emscripten_set_main_loop(MainLoop, 0, 1);

    for (int i = 0; i < MAX_PLAYERS; i++)
        if (players[i].active) FreePlayer(&players[i]);
    Skybox_Unload();
    PlatTex_Unload();
    Fx_UnloadTextures();
    CloseWindow();
    return 0;
}