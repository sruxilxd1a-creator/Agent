/* ============================================================================
 * headmotion.js  —  헤드(이마 부착) 모션 센서 모듈  v1.0
 * ----------------------------------------------------------------------------
 * 휴대폰을 이마에 붙인 자세에서, 고개의 "상하 끄덕임"과 "좌우 휙 돌리기"를
 * 감지해 콜백으로 알려주는 독립 모듈. 프레임워크 의존 없음(순수 JS).
 *
 * [감지하는 두 가지 제스처]
 *   1. tilt  (상하) — 고개를 위/아래로 기울인 '정도와 방향'을 연속값으로 제공.
 *                     "기울인 동안 무언가를 계속 증감"하는 용도(볼륨 등)에 적합.
 *   2. swipe (좌우) — 고개를 한쪽으로 빠르게 휙 돌리는 '순간 동작'을 1회성
 *                     이벤트로 제공. "다음/이전" 같은 토글 동작에 적합.
 *
 * [왜 이런 방식인가 — 설계 근거]
 *   휴대폰을 이마에 붙이면 기기가 거의 수직으로 선다. 이 자세에서
 *   DeviceOrientation 의 절대각(alpha/beta/gamma)은 짐벌락 때문에
 *   값이 ±90/±180 경계에서 튀거나 위·아래가 부호 구분 없이 뭉개진다.
 *   그래서 이 모듈은 절대각 대신 DeviceMotion 의 자이로 회전'속도'
 *   (rotationRate)를 사용한다. 회전속도는 "지금 어느 축으로 얼마나 빨리
 *   도는가"를 직접 주므로 자세와 무관하게 안정적이다.
 *     - swipe : 회전속도의 순간 방향만 본다(누적 없음 → 드리프트 없음).
 *     - tilt  : 회전속도를 시간 적분해 기울기각을 추정하고, 약한 자동
 *               중심복귀로 적분 드리프트를 억제한다.
 *
 * [브라우저 요구사항]
 *   - HTTPS(보안 컨텍스트)에서만 센서가 동작. file:// 에서는 동작 안 함.
 *   - iOS 13+ 는 DeviceMotionEvent.requestPermission() 사용자 동의 필요.
 *     → start() 는 반드시 사용자 탭/클릭 핸들러 안에서 호출할 것.
 *
 * [기본 사용법]
 *   var hm = new HeadMotion({
 *     onTilt:  function(d){ ... },   // 매 프레임: d.angle, d.direction, d.strength
 *     onSwipe: function(d){ ... },   // 1회성:   d.direction === 'left' | 'right'
 *     onStatus:function(s){ ... }    // 상태 변화: 'ready' | 'denied' | 'error' ...
 *   });
 *   startButton.addEventListener('click', function(){ hm.start(); });
 *
 * ==========================================================================*/

(function (global) {
  'use strict';

  /* --------------------------------------------------------------------------
   * 기본 설정값 — new HeadMotion({ ... }) 의 두 번째 용도로 덮어쓸 수 있다.
   * 기기·자세별 편차는 거의 이 값들로 보정된다.
   * ------------------------------------------------------------------------*/
  var DEFAULTS = {
    /* ── 축 매핑 ──
       rotationRate 의 어느 성분이 어느 회전에 해당하는지.
       'alpha' | 'beta' | 'gamma'. 기기/자세에 따라 다르므로
       실기 테스트로 확정한다(아래 "축 보정 방법" 주석 참고). */
    tiltAxis:  'beta',    // 고개 상하(끄덕임) 회전 성분
    swipeAxis: 'alpha',   // 고개 좌우(휙 돌리기) 회전 성분

    /* ── 방향 부호 ──
       동작이 의도와 반대로 나오면 +1 / -1 만 뒤집는다. */
    tiltDir:  +1,         // 고개를 위로 들 때 angle 이 +가 되도록
    swipeDir: -1,         // 오른쪽으로 돌릴 때 +가 되도록

    /* ── tilt(상하) 파라미터 ── */
    tiltDeadzone:  5,     // 데드존(°). 중심에서 ±이 각도 안에서는 onTilt 의
                          //   strength 가 0(움직임 무시).
    tiltFull:      12,    // 이 각도(°) 이상 기울이면 strength 가 최대(1.0).
    tiltGate:      1.5,   // 회전속도 게이트(deg/s). 이보다 느린 미동은
                          //   각도 적분에서 제외(손떨림 차단).
    tiltRecenter:  0.06,  // 기울기각 자동 중심복귀 계수(0~1). 클수록 빨리
                          //   0으로 돌아감 → 드리프트는 줄지만 큰 각 유지가 어려움.
    tiltClamp:     40,    // 기울기각 추정치의 한계(°). 무한정 쌓이지 않게.

    /* ── swipe(좌우) 파라미터 ── */
    swipeThreshold: 90,   // 발동 회전속도(deg/s). 이보다 빠르게 휙 돌리면 1회 발동.
    swipeRelease:   25,   // 재무장 기준(deg/s). 회전속도가 이 아래로 잦아들어야
                          //   다음 swipe 가 발동될 수 있다(연타 방지).
    swipeCooldown:  900,  // swipe 발동 후 최소 대기(ms).

    /* ── 루프 ── */
    loopInterval:  80     // onTilt 호출 주기(ms).
  };

  /* --------------------------------------------------------------------------
   * HeadMotion 생성자
   *   opts: {
   *     onTilt, onSwipe, onStatus  — 콜백
   *     ...DEFAULTS 의 키들          — 설정 덮어쓰기
   *   }
   * ------------------------------------------------------------------------*/
  function HeadMotion(opts) {
    opts = opts || {};

    // 설정 병합 (opts 가 DEFAULTS 를 덮어씀)
    this.cfg = {};
    for (var k in DEFAULTS) {
      this.cfg[k] = (opts[k] !== undefined) ? opts[k] : DEFAULTS[k];
    }

    // 콜백
    this.onTilt   = opts.onTilt   || function () {};
    this.onSwipe  = opts.onSwipe  || function () {};
    this.onStatus = opts.onStatus || function () {};

    // 내부 상태
    this._running   = false;
    this._tiltRate  = 0;     // 현재 상하 회전속도 (deg/s)
    this._tiltAngle = 0;     // 추정 기울기각 (중심 대비, °)
    this._spinRate  = 0;     // 현재 좌우 회전속도 (deg/s)
    this._spinArmed = true;  // swipe 발동 무장 상태
    this._lastSwipeT   = 0;  // 마지막 swipe 시각(ms)
    this._lastMotionT  = 0;  // 직전 devicemotion 타임스탬프(적분 dt용)
    this._eventCount   = 0;  // 수신한 센서 이벤트 수(진단용)
    this._loopTimer    = null;

    // 진단용 최근 원시값
    this.diag = { rotationRate: { alpha: 0, beta: 0, gamma: 0 },
                  tiltRate: 0, spinRate: 0, tiltAngle: 0,
                  eventCount: 0, secure: false };

    // this 바인딩 (이벤트 핸들러용)
    this._onMotion = this._onMotion.bind(this);
    this._loop     = this._loop.bind(this);
  }

  /* --------------------------------------------------------------------------
   * start() — 센서 권한을 요청하고 감지를 시작한다.
   *   ※ 반드시 사용자 제스처(클릭/탭) 핸들러 안에서 호출할 것.
   *      iOS 의 권한 팝업은 사용자 동작 없이는 뜨지 않는다.
   *   반환: Promise<boolean>  (true=시작됨, false=권한 거부/미지원)
   * ------------------------------------------------------------------------*/
  HeadMotion.prototype.start = function () {
    var self = this;

    // 보안 컨텍스트 점검 — file:// 이나 http:// 면 센서가 조용히 막힌다.
    this.diag.secure = !!global.isSecureContext;
    if (!this.diag.secure) {
      this.onStatus('insecure');   // 호출측에 경고를 넘김(계속 시도는 함)
    }

    if (typeof DeviceMotionEvent === 'undefined') {
      this.onStatus('unsupported');
      return Promise.resolve(false);
    }

    // iOS 13+ : 명시적 권한 요청
    var needsPermission =
      (typeof DeviceMotionEvent.requestPermission === 'function');

    function attach() {
      global.addEventListener('devicemotion', self._onMotion, false);
      self._running = true;
      self._lastMotionT = 0;
      self._tiltAngle = 0;
      self._spinArmed = true;
      self._loopTimer = setInterval(self._loop, self.cfg.loopInterval);
      self.onStatus('ready');

      // 일정 시간 내 이벤트가 안 오면 경고(센서 차단/미동작)
      setTimeout(function () {
        if (self._eventCount === 0) self.onStatus('no-events');
      }, 2000);
    }

    if (needsPermission) {
      return DeviceMotionEvent.requestPermission()
        .then(function (res) {
          if (res === 'granted') { attach(); return true; }
          self.onStatus('denied');
          return false;
        })
        .catch(function () {
          self.onStatus('error');
          return false;
        });
    } else {
      // 안드로이드 Chrome 등 — 권한 단계 없이 바로 시작
      attach();
      return Promise.resolve(true);
    }
  };

  /* --------------------------------------------------------------------------
   * stop() — 감지를 중단하고 리스너/타이머를 해제한다.
   * ------------------------------------------------------------------------*/
  HeadMotion.prototype.stop = function () {
    if (!this._running) return;
    this._running = false;
    global.removeEventListener('devicemotion', this._onMotion, false);
    if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
    this._tiltAngle = 0;
    this.onStatus('stopped');
  };

  /* --------------------------------------------------------------------------
   * recenter() — 현재 고개 자세를 새로운 '중심(0°)'으로 삼는다.
   *   호출 시점의 기울기각을 0으로 리셋. 보통 "제스처 모드 진입" 같은
   *   순간에 불러서 사용자의 현재 자세를 기준점으로 잡는다.
   * ------------------------------------------------------------------------*/
  HeadMotion.prototype.recenter = function () {
    this._tiltAngle = 0;
    this._lastMotionT = 0;
  };

  /* --------------------------------------------------------------------------
   * devicemotion 이벤트 핸들러 — 자이로 회전속도를 받아 처리.
   * ------------------------------------------------------------------------*/
  HeadMotion.prototype._onMotion = function (e) {
    var rr = e.rotationRate;
    if (!rr) return;

    this._eventCount++;

    var a = (typeof rr.alpha === 'number') ? rr.alpha : 0;
    var b = (typeof rr.beta  === 'number') ? rr.beta  : 0;
    var g = (typeof rr.gamma === 'number') ? rr.gamma : 0;
    var pick = { alpha: a, beta: b, gamma: g };

    var cfg = this.cfg;

    /* ── 좌우(swipe) : 순간 회전속도 ── */
    this._spinRate = (pick[cfg.swipeAxis] || 0) * cfg.swipeDir;

    /* ── 상하(tilt) : 회전속도를 시간 적분해 기울기각 추정 ── */
    this._tiltRate = (pick[cfg.tiltAxis] || 0) * cfg.tiltDir;

    // 적분 간격 dt — 이벤트 타임스탬프 차이로 계산
    var t  = (typeof e.timeStamp === 'number') ? e.timeStamp : Date.now();
    var dt = (this._lastMotionT > 0) ? (t - this._lastMotionT) / 1000 : 0.016;
    this._lastMotionT = t;
    if (dt > 0.2) dt = 0.2;   // 백그라운드 복귀 등 큰 공백은 무시

    // 게이트보다 빠른 회전만 적분(손떨림 무시)
    if (Math.abs(this._tiltRate) > cfg.tiltGate) {
      this._tiltAngle += this._tiltRate * dt;
    }
    // 자동 중심복귀 — 적분 드리프트를 천천히 0으로 끌어당김
    this._tiltAngle *= (1 - cfg.tiltRecenter);
    // 한계 클램프
    if (this._tiltAngle >  cfg.tiltClamp) this._tiltAngle =  cfg.tiltClamp;
    if (this._tiltAngle < -cfg.tiltClamp) this._tiltAngle = -cfg.tiltClamp;

    // 진단값 갱신
    this.diag.rotationRate = { alpha: a, beta: b, gamma: g };
    this.diag.tiltRate   = this._tiltRate;
    this.diag.spinRate   = this._spinRate;
    this.diag.tiltAngle  = this._tiltAngle;
    this.diag.eventCount = this._eventCount;
  };

  /* --------------------------------------------------------------------------
   * 처리 루프 — loopInterval(ms)마다 실행.
   *   · onTilt  : 매 프레임 호출(현재 기울기 상태 전달)
   *   · onSwipe : 좌우 회전속도가 임계를 넘는 순간 1회 호출
   * ------------------------------------------------------------------------*/
  HeadMotion.prototype._loop = function () {
    if (!this._running) return;
    var cfg = this.cfg;

    /* ── tilt 콜백 ── */
    var angle = this._tiltAngle;
    var absA  = Math.abs(angle);
    var strength = 0;          // 0 = 데드존 안(정지), 1 = tiltFull 이상
    var direction = 'center';
    if (absA > cfg.tiltDeadzone) {
      strength = (absA - cfg.tiltDeadzone) / (cfg.tiltFull - cfg.tiltDeadzone);
      if (strength > 1) strength = 1;
      if (strength < 0) strength = 0;
      direction = (angle > 0) ? 'up' : 'down';
    }
    this.onTilt({
      angle:     angle,        // 추정 기울기각(°). 위로 들면 +, 숙이면 −
      direction: direction,    // 'up' | 'down' | 'center'
      strength:  strength,     // 0~1. 데드존 안이면 0, tiltFull 이상이면 1
      inDeadzone: (direction === 'center')
    });

    /* ── swipe 콜백 ── */
    var now  = Date.now();
    var spin = this._spinRate;
    // 재무장: 회전이 충분히 잦아들면 다음 발동 허용
    if (Math.abs(spin) < cfg.swipeRelease) this._spinArmed = true;

    if (this._spinArmed && (now - this._lastSwipeT) > cfg.swipeCooldown) {
      if (spin >= cfg.swipeThreshold) {
        this._spinArmed = false;
        this._lastSwipeT = now;
        this.onSwipe({ direction: 'right', speed: spin });
      } else if (spin <= -cfg.swipeThreshold) {
        this._spinArmed = false;
        this._lastSwipeT = now;
        this.onSwipe({ direction: 'left', speed: spin });
      }
    }
  };

  /* --------------------------------------------------------------------------
   * getDiagnostics() — 현재 센서 상태 스냅샷(디버그 패널 등에 사용).
   * ------------------------------------------------------------------------*/
  HeadMotion.prototype.getDiagnostics = function () {
    return {
      running:      this._running,
      secure:       this.diag.secure,
      eventCount:   this.diag.eventCount,
      rotationRate: this.diag.rotationRate,  // {alpha,beta,gamma} 원시 회전속도
      tiltRate:     this.diag.tiltRate,      // 상하 회전속도(축·부호 보정 후)
      spinRate:     this.diag.spinRate,      // 좌우 회전속도(축·부호 보정 후)
      tiltAngle:    this.diag.tiltAngle      // 추정 기울기각(°)
    };
  };

  /* ──────────────────────────────────────────────────────────────────────────
   * [축 보정 방법]  — 새 기기에서 동작이 이상할 때
   * ──────────────────────────────────────────────────────────────────────────
   *  getDiagnostics().rotationRate 의 alpha/beta/gamma 세 값을 화면에 띄우고:
   *    1) 고개를 위/아래로만 끄덕인다 → 가장 크게 변하는 성분이 tiltAxis.
   *    2) 고개를 좌/우로만 휙 돌린다 → 가장 크게 변하는 성분이 swipeAxis.
   *    3) 동작 방향이 의도와 반대면 tiltDir / swipeDir 를 -1 로.
   *  이 네 값(tiltAxis, swipeAxis, tiltDir, swipeDir)만 맞추면 대부분의
   *  기기에서 정상 동작한다.
   * ────────────────────────────────────────────────────────────────────────*/

  // 내보내기 — 전역 + (있으면) CommonJS
  global.HeadMotion = HeadMotion;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HeadMotion;
  }

})(typeof window !== 'undefined' ? window : this);
