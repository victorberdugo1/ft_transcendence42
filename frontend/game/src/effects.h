#ifndef EFFECTS_H
#define EFFECTS_H

#include "raylib.h"
#include "raymath.h"
#include "rlgl.h"
#include <math.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FX_SHEET_COLS   4
#define FX_SHEET_ROWS   4
#define FX_FRAME_COUNT  4

typedef enum {
    FX_DASH = 0,
    FX_HIT,
    FX_BLOCK,
    FX_LANDING,
    FX_TYPE_COUNT
} FxType;

static const float FX_DURATION[FX_TYPE_COUNT] = {
    0.28f,
    0.22f,
    0.24f,
    0.30f,
};

static const float FX_SCALE[FX_TYPE_COUNT] = {
    1.3f,
    0.9f,
    0.8f,
    1.2f,
};

static const float FX_Y_OFFSET[FX_TYPE_COUNT] = {
    0.35f,
    0.85f,
    0.85f,
    0.32f,
};

static const char *FX_SHEET_PATH = "data/fx/fx_sheet.png";

typedef struct {
    float timer;
    float facing;
    float wx, wy;
} FxInstance;

typedef struct {
    FxInstance instances[FX_TYPE_COUNT];
} FxState;

static Texture2D g_fxSheet          = {0};
static bool      g_fxLoadAttempted  = false;
static bool      g_fxLoadOk         = false;

static inline bool Fx_TryLoad(void) {
    if (g_fxLoadOk) return true;

    if (!FileExists(FX_SHEET_PATH)) {
        TraceLog(LOG_WARNING, "FX: sheet not found yet at '%s'", FX_SHEET_PATH);
        return false;
    }

    Texture2D tex = LoadTexture(FX_SHEET_PATH);
    if (tex.id == 0) {
        TraceLog(LOG_WARNING, "FX: LoadTexture failed for '%s' (file exists but GPU upload returned id=0)", FX_SHEET_PATH);
        return false;
    }

    SetTextureFilter(tex, TEXTURE_FILTER_BILINEAR);
    g_fxSheet  = tex;
    g_fxLoadOk = true;
    TraceLog(LOG_INFO, "FX: sheet loaded ok (%dx%d, id=%d)", tex.width, tex.height, tex.id);
    return true;
}

static inline void Fx_LoadTextures(void) {
    g_fxLoadAttempted = true;
    Fx_TryLoad();
}

static inline void Fx_UnloadTextures(void) {
    if (g_fxLoadOk && g_fxSheet.id > 0) UnloadTexture(g_fxSheet);
    g_fxSheet         = (Texture2D){0};
    g_fxLoadOk        = false;
    g_fxLoadAttempted = false;
}

static inline void Fx_Init(FxState *fx) {
    for (int i = 0; i < FX_TYPE_COUNT; i++) {
        fx->instances[i].timer  = 0.0f;
        fx->instances[i].facing = 1.0f;
        fx->instances[i].wx     = 0.0f;
        fx->instances[i].wy     = 0.0f;
    }
}

static inline void Fx_Trigger(FxState *fx, FxType type, float wx, float wy, float facing) {
    if (type < 0 || type >= FX_TYPE_COUNT) return;
    FxInstance *inst = &fx->instances[type];
    inst->timer  = FX_DURATION[type];
    inst->facing = (facing < 0.0f) ? -1.0f : 1.0f;
    inst->wx     = wx;
    inst->wy     = wy;
    TraceLog(LOG_INFO, "FX: trigger type=%d at (%.2f, %.2f) facing=%.0f", (int)type, wx, wy, inst->facing);
}

static inline void Fx_Update(FxState *fx, float dt) {
    for (int i = 0; i < FX_TYPE_COUNT; i++) {
        FxInstance *inst = &fx->instances[i];
        if (inst->timer > 0.0f) {
            inst->timer -= dt;
            if (inst->timer < 0.0f) inst->timer = 0.0f;
        }
    }
}

static inline void Fx_DrawInstance(FxType type, const FxInstance *inst, Camera camera) {
    if (inst->timer <= 0.0f) return;
    if (type < 0 || type >= FX_TYPE_COUNT) return;

    if (!g_fxLoadOk) {
        if (!Fx_TryLoad()) return;
    }
    if (g_fxSheet.id <= 0) return;

    float duration = FX_DURATION[type];
    float elapsed  = duration - inst->timer;
    float t        = (duration > 0.0f) ? (elapsed / duration) : 1.0f;
    if (t < 0.0f) t = 0.0f;
    if (t > 0.999f) t = 0.999f;

    /* El frame avanza con el tiempo de vida de la instancia (no con el reloj
       global), así el ciclo 0,1,2,3 se reproduce una sola vez por activación
       y termina junto con el efecto. */
    int frame = (int)(t * FX_FRAME_COUNT);
    if (frame >= FX_FRAME_COUNT) frame = FX_FRAME_COUNT - 1;
    if (frame < 0) frame = 0;

    float frameW = (float)g_fxSheet.width  / FX_SHEET_COLS;
    float frameH = (float)g_fxSheet.height / FX_SHEET_ROWS;

    int row = (int)type;
    int col = frame;

    Rectangle src = { col * frameW, row * frameH, frameW, frameH };
    if (inst->facing < 0.0f) src.width = -src.width;

    float scale  = FX_SCALE[type];
    float aspect = frameH / frameW;
    Vector2 size = { scale, scale * aspect };

    Vector3 pos = { inst->wx, inst->wy + FX_Y_OFFSET[type], 0.35f };

    unsigned char alpha = 255;
    float fadeStart = 0.75f;
    if (t > fadeStart) {
        float fadeT = (t - fadeStart) / (1.0f - fadeStart);
        alpha = (unsigned char)(255.0f * (1.0f - fadeT));
    }
    Color tint = (Color){255, 255, 255, alpha};

    /* Desactivamos test Y escritura de profundidad: este sprite no debe
       competir en el depth buffer con la plataforma/escenario. Si solo
       desactivábamos la escritura, el test seguía activo y, al estar el
       efecto casi a la misma distancia de cámara que el borde de la
       plataforma, el resultado del test "parpadeaba" entre frames
       (z-fighting) — por eso a veces se veía y a veces no. */
    rlDisableDepthTest();
    rlDisableDepthMask();
    DrawBillboardRec(camera, g_fxSheet, src, pos, size, tint);
    rlEnableDepthMask();
    rlEnableDepthTest();
}

static inline void Fx_Draw(const FxState *fx, Camera camera) {
    for (int i = 0; i < FX_TYPE_COUNT; i++) {
        Fx_DrawInstance((FxType)i, &fx->instances[i], camera);
    }
}

#ifdef __cplusplus
}
#endif

#endif
