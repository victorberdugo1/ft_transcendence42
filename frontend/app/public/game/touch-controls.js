'use strict';

/**
 * Sistema de controles táctiles para dispositivos mobile
 * D-pad (movimiento/salto/agachar) + un solo botón de acción:
 *   - tap corto    -> ataque
 *   - mantener     -> bloqueo (mientras se mantiene presionado)
 *   - doble tap    -> dash (si se ataca justo después, sale dash-attack)
 */

const HOLD_MS = 220;
const DOUBLE_TAP_MS = 300;

class TouchControls {
    constructor() {
        this.isMobile = this.detectMobile();
        this.isInGame = false;
        this.touchInputs = {
            moveX: 0,
            jump: false,
            attack: false,
            dash: false,
            dashDir: 0,
            crouch: false,
            block: false,
            dashAttack: false,
        };
        this.dashEndTime = 0;
        this.container = null;

        if (this.isMobile) {
            // Esperar a que el DOM esté listo
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.init());
            } else {
                this.init();
            }
        }
    }

    detectMobile() {
        const userAgent = navigator.userAgent || navigator.vendor || window.opera;
        const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
        return mobileRegex.test(userAgent.toLowerCase()) || window.innerWidth <= 768;
    }

    init() {
        this.createTouchUI();
        this.setupGameStateListeners();
    }

    createTouchUI() {
        const container = document.createElement('div');
        container.id = 'touch-controls-container';
        container.className = 'touch-controls-hidden';

        // D-Pad (Movimiento)
        const dpadSection = document.createElement('div');
        dpadSection.className = 'touch-controls-section touch-dpad-section';
        dpadSection.innerHTML = `
            <div class="touch-dpad">
                <button class="touch-dpad-btn touch-up" data-dir="up" aria-label="Arriba"></button>
                <button class="touch-dpad-btn touch-left" data-dir="left" aria-label="Izquierda"></button>
                <button class="touch-dpad-btn touch-center" disabled></button>
                <button class="touch-dpad-btn touch-right" data-dir="right" aria-label="Derecha"></button>
                <button class="touch-dpad-btn touch-down" data-dir="down" aria-label="Agacharse"></button>
            </div>
        `;

        // Botón de acción único (ataque / bloqueo / dash)
        const actionSection = document.createElement('div');
        actionSection.className = 'touch-controls-section touch-action-section';
        actionSection.innerHTML = `
            <button class="touch-action-btn" data-action="action" aria-label="Acción">
                <span class="touch-btn-label">A</span>
            </button>
        `;

        container.appendChild(dpadSection);
        container.appendChild(actionSection);
        document.body.appendChild(container);

        this.container = container;
        this.setupDpadHandlers();
        this.setupActionHandlers();
    }

    setupDpadHandlers() {
        const dpadBtns = this.container.querySelectorAll('.touch-dpad-btn:not(.touch-center)');
        let lastDirTap = { dir: null, time: 0 };

        dpadBtns.forEach(btn => {
            btn.addEventListener('pointerdown', (e) => {
                const dir = e.target.dataset.dir;
                
                // Detectar doble tap en izq/derecha para DASH
                if ((dir === 'left' || dir === 'right') && lastDirTap.dir === dir) {
                    const now = Date.now();
                    if (now - lastDirTap.time < 300) {
                        // DOBLE TAP de flecha = DASH
                        this.triggerDash(dir === 'left' ? -1 : 1);
                        lastDirTap = { dir: null, time: 0 };
                        return;
                    }
                }
                lastDirTap = { dir: dir === 'left' || dir === 'right' ? dir : null, time: Date.now() };

                this.handleDpadDown(e);
            });
            btn.addEventListener('pointerup', (e) => this.handleDpadUp(e));
            btn.addEventListener('pointercancel', (e) => this.handleDpadUp(e));
            btn.addEventListener('pointerleave', (e) => this.handleDpadUp(e));
        });
    }

    setupActionHandlers() {
        const btn = this.container.querySelector('.touch-action-btn');
        if (!btn) return;

        let holdTimer = null;
        let isBlocking = false;
        let lastAttackTime = 0;

        btn.addEventListener('pointerdown', () => {
            clearTimeout(holdTimer);
            // Después de 220ms, es un hold = bloqueo
            holdTimer = setTimeout(() => {
                isBlocking = true;
                this.touchInputs.block = true;
                btn.classList.add('active');
            }, HOLD_MS);
        });

        btn.addEventListener('pointerup', () => {
            const now = Date.now();
            clearTimeout(holdTimer);
            
            if (isBlocking) {
                // Estaba bloqueando, solo dejar de bloquear
                isBlocking = false;
                this.touchInputs.block = false;
                btn.classList.remove('active');
            } else {
                // Fue un tap corto = ataque
                // Enviar ataque cada tap para que funcione combo como teclado
                this.touchInputs.attack = true;
                lastAttackTime = now;
                setTimeout(() => {
                    this.touchInputs.attack = false;
                }, 50);
            }
        });

        btn.addEventListener('pointercancel', () => {
            clearTimeout(holdTimer);
            if (isBlocking) {
                isBlocking = false;
                this.touchInputs.block = false;
                btn.classList.remove('active');
            }
        });
    }

    handleDpadDown(e) {
        const dir = e.target.dataset.dir;
        e.target.classList.add('active');

        if (dir === 'up') {
            this.touchInputs.jump = true;
        } else if (dir === 'down') {
            this.touchInputs.crouch = true;
        } else if (dir === 'left') {
            this.touchInputs.moveX = -1;
        } else if (dir === 'right') {
            this.touchInputs.moveX = 1;
        }
    }

    handleDpadUp(e) {
        const dir = e.target.dataset.dir;
        e.target.classList.remove('active');

        if (dir === 'up') {
            this.touchInputs.jump = false;
        } else if (dir === 'down') {
            this.touchInputs.crouch = false;
        } else if (dir === 'left' && this.touchInputs.moveX === -1) {
            this.touchInputs.moveX = 0;
        } else if (dir === 'right' && this.touchInputs.moveX === 1) {
            this.touchInputs.moveX = 0;
        }
    }

    triggerDash(dir) {
        const dashDir = dir || (this.touchInputs.moveX !== 0 ? this.touchInputs.moveX : 1);
        const now = Date.now();
        this.touchInputs.dash = true;
        this.touchInputs.dashDir = dashDir;
        this.dashEndTime = now + 120;
        setTimeout(() => {
            this.touchInputs.dash = false;
            this.touchInputs.dashDir = 0;
        }, 50);
    }

    setupGameStateListeners() {
        // No usar eventos custom — confiar en que GameShell.jsx llame directamente
    }

    showControls() {
        if (this.isMobile && this.container) {
            this.container.classList.remove('touch-controls-hidden');
            this.container.classList.add('touch-controls-visible');
        }
    }

    hideControls() {
        if (this.isMobile && this.container) {
            this.container.classList.remove('touch-controls-visible');
            this.container.classList.add('touch-controls-hidden');
        }
    }

    /**
     * Integración con el sistema de inputs actual
     * Aplica los inputs táctiles al frame de entrada
     */
    applyToFrame(frame) {
        if (!this.isMobile) return frame;

        return {
            ...frame,
            moveX: frame.moveX !== 0 ? frame.moveX : this.touchInputs.moveX,
            jump: frame.jump || this.touchInputs.jump,
            attack: frame.attack || this.touchInputs.attack,
            dash: frame.dash || this.touchInputs.dash,
            dashDir: frame.dashDir !== 0 ? frame.dashDir : this.touchInputs.dashDir,
            crouch: frame.crouch || this.touchInputs.crouch,
            block: frame.block || this.touchInputs.block,
            dashAttack: frame.dashAttack || this.touchInputs.dashAttack,
        };
    }

    /**
     * Resetea todos los inputs táctiles (útil para cambios de estado)
     */
    reset() {
        Object.assign(this.touchInputs, {
            moveX: 0,
            jump: false,
            attack: false,
            dash: false,
            dashDir: 0,
            crouch: false,
            block: false,
            dashAttack: false,
        });

        const activeBtns = this.container?.querySelectorAll('.active');
        if (activeBtns) {
            activeBtns.forEach(btn => btn.classList.remove('active'));
        }
    }

    /**
     * Detecta si los controles están visibles
     */
    areVisible() {
        return this.container?.classList.contains('touch-controls-visible') ?? false;
    }
}

// Instancia global — se inicializa cuando el DOM esté listo
window._touchControls = new TouchControls();
