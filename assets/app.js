(function(){

  var FORMWHEEL_HOME = 'https://semicolonxss.github.io/Formwheel/';

  // ---------- Firebase ----------
  var firebaseConfig = {
    apiKey: "AIzaSyBreTSe1m0-xlbF4aupnU5isRZCihR25IE",
    authDomain: "formwheel.firebaseapp.com",
    databaseURL: "https://formwheel-default-rtdb.firebaseio.com/",
    projectId: "formwheel",
    storageBucket: "formwheel.firebasestorage.app",
    messagingSenderId: "431583088241",
    appId: "1:431583088241:web:74e0e34ea1e3e1170c55d0"
  };
  var db = null;
  var fbReady = false;
  try{
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    fbReady = true;
  }catch(e){
    fbReady = false;
  }

  // ---------- utilities ----------
  function uid(len){
    return Math.random().toString(36).slice(2, 2+len);
  }
  function genPin(){
    return String(Math.floor(1000 + Math.random()*9000));
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      var map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
      return map[c];
    });
  }
  function medalTag(i){
    var m = ['🥇','🥈','🥉'][i];
    return m ? '<span class="medal">' + m + '</span>' : '';
  }
  function timeAgoLabel(ts){
    if(!ts) return '';
    var diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if(diffSec < 60) return '방금 전';
    var diffMin = Math.floor(diffSec / 60);
    if(diffMin < 60) return diffMin + '분 전';
    var diffHr = Math.floor(diffMin / 60);
    if(diffHr < 24) return diffHr + '시간 전';
    var diffDay = Math.floor(diffHr / 24);
    return diffDay + '일 전';
  }

  async function storeGet(key){
    if(!fbReady) return null;
    try{
      var snap = await db.ref('data/' + key).once('value');
      return snap.exists() ? snap.val() : null;
    }catch(e){
      return null;
    }
  }
  async function storeSet(key, val){
    if(!fbReady) return false;
    try{
      await db.ref('data/' + key).set(val);
      return true;
    }catch(e){
      return false;
    }
  }
  async function storeList(prefix){
    if(!fbReady) return [];
    try{
      var snap = await db.ref('data')
        .orderByKey()
        .startAt(prefix)
        .endAt(prefix + '\uf8ff')
        .once('value');
      var val = snap.val() || {};
      return Object.keys(val);
    }catch(e){
      return [];
    }
  }
  // Saves a reusable copy of the quiz to a shared library (used by FormWheel Battle)
  async function saveToLibrary(quizId, payload){
    if(!fbReady) return false;
    try{
      await db.ref('quizzes/' + quizId).set(payload);
      return true;
    }catch(e){
      return false;
    }
  }

  // ---------- local draft (temporary save) ----------
  var DRAFT_STORAGE_KEY = 'formwheel_quiz_drafts_v1';
  var draftAutosaveTimer = null;
  var currentDraftId = null;

  function loadLocalDrafts(){
    try{
      var raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === 'object') ? parsed : {};
    }catch(e){
      return {};
    }
  }
  function saveLocalDrafts(drafts){
    try{
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
      return true;
    }catch(e){
      return false;
    }
  }
  function upsertLocalDraft(id, data){
    var drafts = loadLocalDrafts();
    drafts[id] = data;
    return saveLocalDrafts(drafts);
  }
  function deleteLocalDraft(id){
    var drafts = loadLocalDrafts();
    delete drafts[id];
    saveLocalDrafts(drafts);
  }
  function listLocalDrafts(){
    var drafts = loadLocalDrafts();
    return Object.keys(drafts).map(function(id){
      var d = drafts[id];
      return {
        id: id,
        title: d.title || '',
        questionCount: (d.questions || []).length,
        timeLimit: d.timeLimit,
        savedAt: d.savedAt || 0
      };
    }).sort(function(a,b){ return b.savedAt - a.savedAt; });
  }

  function scheduleDraftAutosave(){
    var statusEl = document.getElementById('saveStatus');
    if(statusEl){
      statusEl.classList.add('saving');
      statusEl.querySelector('.stext').textContent = '저장 중...';
    }
    if(draftAutosaveTimer) clearTimeout(draftAutosaveTimer);
    draftAutosaveTimer = setTimeout(function(){
      persistCurrentDraft();
    }, 600);
  }
  function persistCurrentDraft(){
    if(!currentDraftId) currentDraftId = uid(10);
    var savedAt = Date.now();
    upsertLocalDraft(currentDraftId, {
      title: S.draftTitle || '',
      timeLimit: draftTimeLimit,
      questions: S.draftQuestions,
      savedAt: savedAt
    });
    var statusEl = document.getElementById('saveStatus');
    if(statusEl){
      statusEl.classList.remove('saving');
      statusEl.querySelector('.stext').textContent = '임시저장됨 · ' + timeAgoLabel(savedAt);
    }
  }

  // ---------- app state ----------
  var app = document.getElementById('app');
  var pollTimer = null;
  var questionTickTimer = null;
  var draftTimeLimit = 20;
  var lobbyPlayers = [];
  var hostAnswerCount = 0;

  var S = {
    screen: 'home',
    role: null,
    pin: null,
    playerId: null,
    playerName: '',
    meta: null,
    draftQuestions: null,
    draftTitle: '',
    lastAnswer: null,
    _qIndex: 0,
    _questionStartedAt: 0
  };

  function clearTimers(){
    if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
    if(questionTickTimer){ clearInterval(questionTickTimer); questionTickTimer = null; }
    if(draftAutosaveTimer){ clearTimeout(draftAutosaveTimer); draftAutosaveTimer = null; }
  }

  function goto(screen){
    clearTimers();
    S.screen = screen;
    render();
  }

  function defaultQuestions(){
    return [
      { text: '다음 중 대한민국의 수도는 어디일까요?', choices: ['부산','서울','인천','대구'], correct: 1 },
      { text: '물의 화학식은 무엇일까요?', choices: ['CO2','O2','H2O','NaCl'], correct: 2 },
      { text: '태양계에서 가장 큰 행성은?', choices: ['지구','목성','화성','토성'], correct: 1 },
      { text: '1년은 총 며칠일까요? (평년 기준)', choices: ['364일','365일','366일','360일'], correct: 1 }
    ];
  }

  function navbarHtml(rightText){
    return '' +
      '<div class="navbar">' +
        '<button class="brand" id="brandBtn">' +
          '<span class="mark">F</span>' +
          '<span class="wordmark">FormWheel</span>' +
          '<span class="tag">Quiz</span>' +
        '</button>' +
        '<span class="nav-meta">' + (rightText || '') + '</span>' +
      '</div>';
  }
  function wireNavbar(){
    var b = document.getElementById('brandBtn');
    if(b) b.onclick = function(){ window.open(FORMWHEEL_HOME, '_blank'); };
  }

  // ---------- render router ----------
  function render(){
    if(!fbReady){
      app.innerHTML = navbarHtml('') +
        '<main><div class="stage"><div class="card">' +
          '<h1 class="title">연결에 문제가 있어요</h1>' +
          '<p class="sub">데이터베이스 연결을 초기화하지 못했어요. 인터넷 연결을 확인하고 새로고침 해주세요.</p>' +
        '</div></div></main>';
      wireNavbar();
      return;
    }
    if(S.screen === 'home') return renderHome();
    if(S.screen === 'host-setup') return renderHostSetup();
    if(S.screen === 'host-lobby') return renderHostLobby();
    if(S.screen === 'host-question') return renderHostQuestion();
    if(S.screen === 'host-reveal') return renderHostReveal();
    if(S.screen === 'host-final') return renderHostFinal();
    if(S.screen === 'join') return renderJoin();
    if(S.screen === 'player-lobby') return renderPlayerLobby();
    if(S.screen === 'player-question') return renderPlayerQuestion();
    if(S.screen === 'player-waiting') return renderPlayerWaiting();
    if(S.screen === 'player-reveal') return renderPlayerReveal();
    if(S.screen === 'player-final') return renderPlayerFinal();
  }

  // ---------- HOME ----------
  function renderHome(){
    var drafts = listLocalDrafts();
    var draftsHtml = drafts.length ? drafts.map(function(d){
      var titleLabel = d.title.trim() || '제목 없는 Quiz';
      return '' +
        '<div class="draft-card" data-id="' + d.id + '">' +
          '<div class="dinfo">' +
            '<div class="dtitle">' + escapeHtml(titleLabel) + '</div>' +
            '<div class="dmeta">문제 ' + d.questionCount + '개 · ' + timeAgoLabel(d.savedAt) + ' 저장됨</div>' +
          '</div>' +
          '<div class="dactions">' +
            '<button class="icon-btn resume-draft" data-id="' + d.id + '">이어하기</button>' +
            '<button class="icon-btn danger delete-draft" data-id="' + d.id + '">삭제</button>' +
          '</div>' +
        '</div>';
    }).join('') : '';

    app.innerHTML =
      navbarHtml('') +
      '<main><div class="stage">' +
        '<h1 class="title">Quiz 만들기</h1>' +
        '<p class="sub">각자 폰이나 PC로 접속해서 실시간으로 맞히는 퀴즈예요. 이 게임의 점수는 저장되지 않고, 창을 닫으면 사라져요.</p>' +
        draftsHtml +
        '<div class="home-choice">' +
          '<div class="home-card" id="pickHost"><h3>퀴즈 만들기</h3><p>문제를 준비하고 참가 코드를 발급해요. 큰 화면(발표용)에 띄워두세요.</p></div>' +
          '<div class="home-card" id="pickJoin"><h3>참가하기</h3><p>진행자에게 받은 코드를 입력하고 닉네임으로 들어가요.</p></div>' +
        '</div>' +
      '</div></main>';
    wireNavbar();
    document.getElementById('pickHost').onclick = function(){
      currentDraftId = null;
      S.draftQuestions = defaultQuestions();
      S.draftTitle = '';
      draftTimeLimit = 20;
      goto('host-setup');
    };
    document.getElementById('pickJoin').onclick = function(){ goto('join'); };

    document.querySelectorAll('.resume-draft').forEach(function(btn){
      btn.onclick = function(e){
        e.stopPropagation();
        var id = btn.dataset.id;
        var drafts = loadLocalDrafts();
        var d = drafts[id];
        if(!d) return;
        currentDraftId = id;
        S.draftQuestions = (d.questions && d.questions.length) ? d.questions : defaultQuestions();
        S.draftTitle = d.title || '';
        draftTimeLimit = d.timeLimit || 20;
        goto('host-setup');
      };
    });
    document.querySelectorAll('.delete-draft').forEach(function(btn){
      btn.onclick = function(e){
        e.stopPropagation();
        deleteLocalDraft(btn.dataset.id);
        renderHome();
      };
    });
  }

  // ---------- HOST: setup ----------
  function renderHostSetup(){
    var qs = S.draftQuestions;
    var timeSegHtml = [10,15,20,30].map(function(t){
      return '<div class="seg-btn ' + (t===draftTimeLimit?'active':'') + '" data-t="' + t + '">' + t + '초</div>';
    }).join('');

    app.innerHTML =
      navbarHtml('') +
      '<main><div class="stage">' +
        '<h1 class="title">문제 준비하기</h1>' +
        '<p class="sub">문제와 보기 4개, 정답을 정해주세요. 필요하면 문제를 더 추가하거나 지울 수 있어요.</p>' +
        '<div class="save-status" id="saveStatus"><span class="dot"></span><span class="stext">이 브라우저에 자동으로 임시저장돼요</span></div>' +
        '<div class="field"><label class="flabel">Quiz 제목</label><input type="text" id="quizTitleInput" maxlength="30" placeholder="예: 상식 퀴즈" value="' + escapeHtml(S.draftTitle || '') + '" /></div>' +
        '<div class="field"><label class="flabel">문제당 제한 시간</label><div class="seglist" id="timeSeg">' + timeSegHtml + '</div></div>' +
        '<div id="qlist"></div>' +
        '<button class="btn ghost" id="addQ" style="margin-bottom:12px;">질문 추가</button>' +
        '<button class="btn ghost" id="saveDraftBtn" style="margin-bottom:18px;">지금 임시저장</button>' +
        '<button class="btn" id="createGame">게임 만들고 코드 받기</button>' +
        '<div class="errmsg" id="createErr"></div>' +
      '</div></main>';
    wireNavbar();

    var qlist = document.getElementById('qlist');
    qlist.innerHTML = qs.map(function(q, qi){
      var choicesHtml = q.choices.map(function(c, ci){
        return '' +
          '<div class="qedit-choice-row">' +
            '<input type="radio" name="correct-' + qi + '" data-qi="' + qi + '" data-ci="' + ci + '" class="correct-radio" ' + (q.correct===ci?'checked':'') + ' />' +
            '<input type="text" class="choice-input" data-qi="' + qi + '" data-ci="' + ci + '" value="' + escapeHtml(c) + '" placeholder="보기 ' + (ci+1) + '" />' +
          '</div>';
      }).join('');
      return '' +
        '<div class="qedit-card" data-qi="' + qi + '">' +
          '<div class="field"><label class="flabel">문제 ' + (qi+1) + '</label>' +
          '<input type="text" class="qtext-input" data-qi="' + qi + '" value="' + escapeHtml(q.text) + '" placeholder="문제를 입력하세요" /></div>' +
          choicesHtml +
          (qs.length > 1 ? '<button class="remove-link" data-qi="' + qi + '">이 문제 삭제</button>' : '') +
        '</div>';
    }).join('');

    document.getElementById('timeSeg').querySelectorAll('.seg-btn').forEach(function(el){
      el.onclick = function(){ draftTimeLimit = parseInt(el.dataset.t, 10); renderHostSetup(); scheduleDraftAutosave(); };
    });
    qlist.querySelectorAll('.qtext-input').forEach(function(el){
      el.oninput = function(){ qs[+el.dataset.qi].text = el.value; scheduleDraftAutosave(); };
    });
    qlist.querySelectorAll('.choice-input').forEach(function(el){
      el.oninput = function(){ qs[+el.dataset.qi].choices[+el.dataset.ci] = el.value; scheduleDraftAutosave(); };
    });
    qlist.querySelectorAll('.correct-radio').forEach(function(el){
      el.onchange = function(){ qs[+el.dataset.qi].correct = +el.dataset.ci; scheduleDraftAutosave(); };
    });
    qlist.querySelectorAll('.remove-link').forEach(function(el){
      el.onclick = function(){ qs.splice(+el.dataset.qi, 1); renderHostSetup(); scheduleDraftAutosave(); };
    });
    document.getElementById('addQ').onclick = function(){
      qs.push({ text: '', choices: ['','','',''], correct: 0 });
      renderHostSetup();
      scheduleDraftAutosave();
    };
    document.getElementById('quizTitleInput').oninput = function(){
      S.draftTitle = this.value;
      scheduleDraftAutosave();
    };
    document.getElementById('saveDraftBtn').onclick = function(){
      persistCurrentDraft();
    };

    // if this draft was loaded (or already autosaved once), show its last-saved time
    if(currentDraftId){
      var drafts = loadLocalDrafts();
      var existing = drafts[currentDraftId];
      if(existing && existing.savedAt){
        var statusEl = document.getElementById('saveStatus');
        if(statusEl) statusEl.querySelector('.stext').textContent = '임시저장됨 · ' + timeAgoLabel(existing.savedAt);
      }
    }

    document.getElementById('createGame').onclick = async function(){
      var errEl = document.getElementById('createErr');
      for(var i=0;i<qs.length;i++){
        var q = qs[i];
        if(!q.text.trim() || q.choices.some(function(c){ return !c.trim(); })){
          errEl.textContent = '모든 문제와 보기 4개를 채워주세요.';
          return;
        }
      }
      errEl.textContent = '생성 중...';
      var pin = null;
      for(var a=0;a<8;a++){
        var candidate = genPin();
        var exists = await storeGet('qz:'+candidate+':meta');
        if(!exists){ pin = candidate; break; }
      }
      if(!pin){
        errEl.textContent = '코드 생성에 실패했어요. 다시 시도해주세요.';
        return;
      }
      S.pin = pin;
      S.meta = { questions: qs.map(function(q){ return { text: q.text, choices: q.choices.slice(), correct: q.correct }; }), timeLimit: draftTimeLimit };
      await storeSet('qz:'+pin+':meta', S.meta);
      await storeSet('qz:'+pin+':state', { phase: 'lobby', qIndex: -1, questionStartedAt: 0 });
      saveToLibrary(uid(10), {
        title: (S.draftTitle || '').trim() || '제목 없는 Quiz',
        questions: S.meta.questions,
        timeLimit: S.meta.timeLimit,
        createdAt: Date.now()
      });
      // 임시저장은 게임을 배포해도 삭제하지 않고 그대로 유지합니다.
      if(currentDraftId){
        persistCurrentDraft();
      }
      S.role = 'host';
      S._qIndex = 0;
      goto('host-lobby');
    };
  }

  // ---------- HOST: lobby ----------
  function renderHostLobby(){
    app.innerHTML =
      navbarHtml('코드 <b>' + S.pin + '</b>') +
      '<main><div class="stage wide">' +
        '<div class="pin-box"><div class="plabel">참가 코드</div><div class="pin">' + S.pin + '</div></div>' +
        '<p class="sub" style="text-align:center;" id="lobbySub">참가자들은 이 코드와 닉네임으로 접속해요. (0명 참가 중)</p>' +
        '<div class="player-wrap" id="players"></div>' +
        '<div class="footer-actions">' +
          '<button class="btn" id="startBtn" disabled>게임 시작하기</button>' +
          '<button class="btn ghost" id="cancelBtn">취소하고 처음으로</button>' +
        '</div>' +
      '</div></main>';
    wireNavbar();
    renderPlayerChips();

    document.getElementById('startBtn').onclick = async function(){
      S._qIndex = 0;
      await storeSet('qz:'+S.pin+':state', { phase: 'question', qIndex: 0, questionStartedAt: Date.now() });
      goto('host-question');
    };
    document.getElementById('cancelBtn').onclick = function(){ resetToHome(); };

    pollTimer = setInterval(pollLobby, 1500);
    pollLobby();
  }
  function renderPlayerChips(){
    var el = document.getElementById('players');
    if(!el) return;
    el.innerHTML = lobbyPlayers.length
      ? lobbyPlayers.map(function(p){ return '<span class="player-chip">' + escapeHtml(p.name) + '</span>'; }).join('')
      : '<span style="color:var(--muted);font-size:13.5px;">아직 참가자가 없어요. 코드를 알려주세요.</span>';
  }
  async function pollLobby(){
    var keys = await storeList('qz:'+S.pin+':player:');
    var players = [];
    for(var i=0;i<keys.length;i++){
      var v = await storeGet(keys[i]);
      if(v) players.push(v);
    }
    lobbyPlayers = players;
    renderPlayerChips();
    var btn = document.getElementById('startBtn');
    if(btn) btn.disabled = lobbyPlayers.length === 0;
    var sub = document.getElementById('lobbySub');
    if(sub) sub.textContent = '참가자들은 이 코드와 닉네임으로 접속해요. (' + lobbyPlayers.length + '명 참가 중)';
  }

  // ---------- HOST: question ----------
  function renderHostQuestion(){
    var qi = S._qIndex;
    var q = S.meta.questions[qi];
    var choicesHtml = q.choices.map(function(c,i){
      return '<div class="choice-btn ' + ['a','b','c','d'][i] + '">' + escapeHtml(c) + '</div>';
    }).join('');

    app.innerHTML =
      navbarHtml('코드 <b>' + S.pin + '</b>') +
      '<main><div class="stage wide">' +
        '<div class="topbar"><span class="pinmini">문제 ' + (qi+1) + ' / ' + S.meta.questions.length + '</span><span></span></div>' +
        '<div class="timerbar-track"><div class="timerbar-fill" id="tfill" style="width:100%"></div></div>' +
        '<div class="qtext">' + escapeHtml(q.text) + '</div>' +
        '<div class="choices-grid">' + choicesHtml + '</div>' +
        '<p class="sub" style="margin-top:16px;text-align:center;" id="answeredCount">응답 0명</p>' +
        '<button class="btn" id="revealBtn" style="margin-top:6px;">지금 결과 보기</button>' +
      '</div></main>';
    wireNavbar();
    document.getElementById('revealBtn').onclick = function(){ goToReveal(); };

    pollTimer = setInterval(pollAnswerCount, 1000);
    pollAnswerCount();

    var started = Date.now();
    storeGet('qz:'+S.pin+':state').then(function(st){ if(st) started = st.questionStartedAt; });

    questionTickTimer = setInterval(function(){
      var elapsed = (Date.now() - started) / 1000;
      var pct = Math.max(0, 100 * (1 - elapsed / S.meta.timeLimit));
      var fill = document.getElementById('tfill');
      if(fill) fill.style.width = pct + '%';
      if(elapsed >= S.meta.timeLimit){
        goToReveal();
      }
    }, 200);
  }

  async function pollAnswerCount(){
    var keys = await storeList('qz:'+S.pin+':ans:'+S._qIndex+':');
    hostAnswerCount = keys.length;
    var el = document.getElementById('answeredCount');
    if(el) el.textContent = '응답 ' + hostAnswerCount + '명';
  }

  async function goToReveal(){
    clearTimers();
    await storeSet('qz:'+S.pin+':state', { phase: 'reveal', qIndex: S._qIndex, questionStartedAt: 0 });
    goto('host-reveal');
  }

  // ---------- HOST: reveal ----------
  async function renderHostReveal(){
    var qi = S._qIndex;
    var q = S.meta.questions[qi];
    app.innerHTML = navbarHtml('코드 <b>' + S.pin + '</b>') + '<main><div class="stage wide"><p class="sub">결과 집계 중...</p></div></main>';

    var ansKeys = await storeList('qz:'+S.pin+':ans:'+qi+':');
    var answers = [];
    for(var i=0;i<ansKeys.length;i++){
      var v = await storeGet(ansKeys[i]);
      if(v) answers.push(v);
    }
    var counts = [0,0,0,0];
    answers.forEach(function(a){ if(a.choice>=0 && a.choice<4) counts[a.choice]++; });
    var total = answers.length || 1;

    var pKeys = await storeList('qz:'+S.pin+':player:');
    var players = [];
    for(var j=0;j<pKeys.length;j++){
      var pv = await storeGet(pKeys[j]);
      if(pv) players.push(pv);
    }
    players.sort(function(a,b){ return b.score - a.score; });

    var colorVars = ['var(--c-a)','var(--c-b)','var(--c-c)','var(--c-d)'];
    var isLast = qi === S.meta.questions.length - 1;

    var barsHtml = q.choices.map(function(c,i){
      return '' +
        '<div class="bar-row">' +
          '<div class="barlabel"><span>' + (i===q.correct?'✓ ':'') + escapeHtml(c) + '</span><span>' + counts[i] + '명</span></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + Math.round(counts[i]/total*100) + '%; background:' + colorVars[i] + ';"></div></div>' +
        '</div>';
    }).join('');

    var leadHtml = players.slice(0,5).map(function(p,i){
      return '' +
        '<div class="lead-row">' +
          '<span class="rank">' + (i+1) + '</span>' +
          '<span class="name">' + medalTag(i) + escapeHtml(p.name) + '</span>' +
          '<span class="score">' + p.score + '</span>' +
        '</div>';
    }).join('');

    app.innerHTML =
      navbarHtml('코드 <b>' + S.pin + '</b>') +
      '<main><div class="stage wide">' +
        '<div class="topbar"><span class="pinmini">문제 ' + (qi+1) + ' / ' + S.meta.questions.length + '</span><span></span></div>' +
        '<div class="qtext">' + escapeHtml(q.text) + '</div>' +
        barsHtml +
        '<p class="sub" style="margin-top:18px;margin-bottom:8px;">현재 순위</p>' +
        leadHtml +
        '<button class="btn" id="nextBtn" style="margin-top:16px;">' + (isLast ? '최종 결과 보기' : '다음 문제') + '</button>' +
      '</div></main>';
    wireNavbar();

    document.getElementById('nextBtn').onclick = async function(){
      if(isLast){
        await storeSet('qz:'+S.pin+':state', { phase: 'final', qIndex: qi, questionStartedAt: 0 });
        goto('host-final');
      } else {
        var nextI = qi + 1;
        S._qIndex = nextI;
        await storeSet('qz:'+S.pin+':state', { phase: 'question', qIndex: nextI, questionStartedAt: Date.now() });
        goto('host-question');
      }
    };
  }

  // ---------- HOST: final ----------
  async function renderHostFinal(){
    app.innerHTML = navbarHtml('코드 <b>' + S.pin + '</b>') + '<main><div class="stage wide"><p class="sub">최종 결과 불러오는 중...</p></div></main>';
    var pKeys = await storeList('qz:'+S.pin+':player:');
    var players = [];
    for(var i=0;i<pKeys.length;i++){
      var v = await storeGet(pKeys[i]);
      if(v) players.push(v);
    }
    players.sort(function(a,b){ return b.score - a.score; });

    var leadHtml = players.map(function(p,i){
      return '' +
        '<div class="lead-row">' +
          '<span class="rank">' + (i+1) + '</span>' +
          '<span class="name">' + medalTag(i) + escapeHtml(p.name) + '</span>' +
          '<span class="score">' + p.score + '</span>' +
        '</div>';
    }).join('');

    app.innerHTML =
      navbarHtml('') +
      '<main><div class="stage wide">' +
        '<h1 class="title">최종 결과</h1>' +
        '<p class="sub">수고하셨어요! 이 게임의 점수는 저장되지 않아요.</p>' +
        leadHtml +
        '<button class="btn" id="newGameBtn" style="margin-top:20px;">새 게임 만들기</button>' +
      '</div></main>';
    wireNavbar();
    document.getElementById('newGameBtn').onclick = function(){ resetToHome(); };
  }

  // ---------- JOIN ----------
  function renderJoin(){
    app.innerHTML =
      navbarHtml('') +
      '<main><div class="stage">' +
        '<h1 class="title">참가하기</h1>' +
        '<p class="sub">진행자가 알려준 코드와 사용할 닉네임을 입력하세요.</p>' +
        '<div class="field"><label class="flabel">참가 코드</label><input type="tel" id="pinInput" maxlength="4" placeholder="예: 4821" /></div>' +
        '<div class="field"><label class="flabel">닉네임</label><input type="text" id="nameInput" maxlength="12" placeholder="닉네임" /></div>' +
        '<button class="btn" id="joinBtn">참가하기</button>' +
        '<div class="errmsg" id="joinErr"></div>' +
        '<button class="btn ghost" id="backBtn" style="margin-top:10px;">뒤로가기</button>' +
      '</div></main>';
    wireNavbar();
    document.getElementById('backBtn').onclick = function(){ resetToHome(); };
    document.getElementById('joinBtn').onclick = async function(){
      var pin = document.getElementById('pinInput').value.trim();
      var name = document.getElementById('nameInput').value.trim();
      var errEl = document.getElementById('joinErr');
      if(!/^\d{4}$/.test(pin)){ errEl.textContent = '4자리 코드를 입력해주세요.'; return; }
      if(!name){ errEl.textContent = '닉네임을 입력해주세요.'; return; }
      errEl.textContent = '확인 중...';
      var meta = await storeGet('qz:'+pin+':meta');
      if(!meta){ errEl.textContent = '존재하지 않는 코드예요. 다시 확인해주세요.'; return; }
      S.pin = pin;
      S.meta = meta;
      S.playerId = uid(8);
      S.playerName = name;
      S.role = 'player';
      await storeSet('qz:'+pin+':player:'+S.playerId, { name: name, score: 0 });
      goto('player-lobby');
    };
  }

  // ---------- PLAYER: lobby ----------
  function renderPlayerLobby(){
    app.innerHTML =
      navbarHtml('코드 <b>' + S.pin + '</b>') +
      '<main><div class="stage">' +
        '<div class="center-msg">' +
          '<div class="big">⏳</div>' +
          '<h1 class="title">' + escapeHtml(S.playerName) + '님, 준비됐어요!</h1>' +
          '<p class="sub">진행자가 게임을 시작하면 바로 문제가 나와요.</p>' +
        '</div>' +
      '</div></main>';
    wireNavbar();
    pollTimer = setInterval(pollPlayerState, 1200);
    pollPlayerState();
  }

  async function pollPlayerState(){
    var st = await storeGet('qz:'+S.pin+':state');
    if(!st) return;
    if(st.phase === 'question'){
      S._qIndex = st.qIndex;
      S._questionStartedAt = st.questionStartedAt;
      S.lastAnswer = null;
      goto('player-question');
    } else if(st.phase === 'final'){
      goto('player-final');
    }
  }

  // ---------- PLAYER: question ----------
  function renderPlayerQuestion(){
    var qi = S._qIndex;
    var q = S.meta.questions[qi];
    var choicesHtml = q.choices.map(function(c,i){
      return '<button class="choice-btn ' + ['a','b','c','d'][i] + '" data-i="' + i + '">' + escapeHtml(c) + '</button>';
    }).join('');

    app.innerHTML =
      navbarHtml('') +
      '<main><div class="stage">' +
        '<div class="timerbar-track"><div class="timerbar-fill" id="tfill" style="width:100%"></div></div>' +
        '<div class="qtext">' + escapeHtml(q.text) + '</div>' +
        '<div class="choices-grid" id="choiceGrid">' + choicesHtml + '</div>' +
      '</div></main>';
    wireNavbar();

    document.querySelectorAll('#choiceGrid .choice-btn').forEach(function(btn){
      btn.onclick = function(){ submitAnswer(+btn.dataset.i); };
    });

    questionTickTimer = setInterval(function(){
      var elapsed = (Date.now() - S._questionStartedAt) / 1000;
      var pct = Math.max(0, 100 * (1 - elapsed / S.meta.timeLimit));
      var fill = document.getElementById('tfill');
      if(fill) fill.style.width = pct + '%';
      if(elapsed >= S.meta.timeLimit){
        clearInterval(questionTickTimer);
        if(!S.lastAnswer){ goto('player-waiting'); }
      }
    }, 200);

    pollTimer = setInterval(async function(){
      var st = await storeGet('qz:'+S.pin+':state');
      if(st && st.phase === 'reveal' && st.qIndex === qi){
        goto('player-reveal');
      }
    }, 1000);
  }

  async function submitAnswer(choiceIdx){
    var qi = S._qIndex;
    var q = S.meta.questions[qi];
    document.querySelectorAll('#choiceGrid .choice-btn').forEach(function(b){
      b.disabled = true;
      if(+b.dataset.i !== choiceIdx) b.classList.add('dim');
      else b.classList.add('picked');
    });

    var elapsedSec = Math.max(0, (Date.now() - S._questionStartedAt) / 1000);
    var isCorrect = choiceIdx === q.correct && elapsedSec <= S.meta.timeLimit;
    var speedRatio = Math.max(0, 1 - elapsedSec / S.meta.timeLimit);
    var points = isCorrect ? Math.round(500 + 500 * speedRatio) : 0;

    var answerKey='qz:'+S.pin+':ans:'+qi+':'+S.playerId;
    var playerKey='qz:'+S.pin+':player:'+S.playerId;
    if(!fbReady){alert('온라인 연결 후 다시 제출해주세요.');return;}
    try{
      var result=await db.ref('data').transaction(function(data){
        if(!data || data[answerKey] || !data[playerKey])return;
        data[answerKey]={choice:choiceIdx,points:points,answeredAt:Date.now()};
        data[playerKey].score=Number(data[playerKey].score||0)+points;
        return data;
      },undefined,false);
      if(result.committed)S.lastAnswer={choice:choiceIdx,points:points,correct:isCorrect};
      else {var existing=await storeGet(answerKey);if(existing)S.lastAnswer={choice:existing.choice,points:existing.points,correct:existing.choice===q.correct};}
    }catch(error){
      document.querySelectorAll('#choiceGrid .choice-btn').forEach(function(b){b.disabled=false});
      alert('답안 저장에 실패했습니다. 다시 제출해주세요.');return;
    }

    setTimeout(function(){ if(S.screen === 'player-question') goto('player-waiting'); }, 500);
  }

  function renderPlayerWaiting(){
    app.innerHTML =
      navbarHtml('') +
      '<main><div class="stage">' +
        '<div class="center-msg">' +
          '<div class="big">✅</div>' +
          '<h1 class="title">제출 완료!</h1>' +
          '<p class="sub">다른 사람들이 답하는 중이에요. 결과를 기다려주세요.</p>' +
        '</div>' +
      '</div></main>';
    wireNavbar();
    pollTimer = setInterval(async function(){
      var st = await storeGet('qz:'+S.pin+':state');
      if(st && st.phase === 'reveal' && st.qIndex === S._qIndex){
        goto('player-reveal');
      }
    }, 1000);
  }

  // ---------- PLAYER: reveal ----------
  function renderPlayerReveal(){
    var a = S.lastAnswer;
    var correct = a ? a.correct : false;
    var points = a ? a.points : 0;

    app.innerHTML =
      navbarHtml('') +
      '<main><div class="stage">' +
        '<div class="center-msg">' +
          '<div class="big">' + (a ? (correct ? '🎉' : '😵') : '⌛') + '</div>' +
          '<h1 class="title">' + (a ? (correct ? '정답이에요!' : '아쉬워요') : '시간 초과') + '</h1>' +
          '<p class="sub">' + (a ? ('+' + points + '점 획득') : '이번 문제는 응답하지 못했어요.') + '</p>' +
        '</div>' +
      '</div></main>';
    wireNavbar();

    pollTimer = setInterval(async function(){
      var st = await storeGet('qz:'+S.pin+':state');
      if(!st) return;
      if(st.phase === 'question' && st.qIndex !== S._qIndex){
        S._qIndex = st.qIndex;
        S._questionStartedAt = st.questionStartedAt;
        S.lastAnswer = null;
        goto('player-question');
      } else if(st.phase === 'final'){
        goto('player-final');
      }
    }, 1200);
  }

  // ---------- PLAYER: final ----------
  async function renderPlayerFinal(){
    app.innerHTML = navbarHtml('') + '<main><div class="stage"><p class="sub">최종 결과 불러오는 중...</p></div></main>';
    var myKey = 'qz:'+S.pin+':player:'+S.playerId;
    var pKeys = await storeList('qz:'+S.pin+':player:');
    var players = [];
    for(var i=0;i<pKeys.length;i++){
      var v = await storeGet(pKeys[i]);
      if(v) players.push({ name: v.name, score: v.score, isMe: pKeys[i] === myKey });
    }
    players.sort(function(a,b){ return b.score - a.score; });
    var myRank = players.findIndex(function(p){ return p.isMe; }) + 1;

    var leadHtml = players.map(function(p,i){
      return '' +
        '<div class="lead-row ' + (p.isMe?'me':'') + '">' +
          '<span class="rank">' + (i+1) + '</span>' +
          '<span class="name">' + medalTag(i) + escapeHtml(p.name) + (p.isMe?' (나)':'') + '</span>' +
          '<span class="score">' + p.score + '</span>' +
        '</div>';
    }).join('');

    app.innerHTML =
      navbarHtml('') +
      '<main><div class="stage">' +
        '<div class="center-msg" style="margin-bottom:16px;padding:16px 0;">' +
          '<div class="big">🏁</div>' +
          '<h1 class="title">최종 순위 ' + myRank + '위</h1>' +
          '<p class="sub">수고하셨어요!</p>' +
        '</div>' +
        leadHtml +
      '</div></main>';
    wireNavbar();
  }

  // ---------- reset ----------
  function resetToHome(){
    clearTimers();
    currentDraftId = null;
    S.screen = 'home';
    S.role = null;
    S.pin = null;
    S.playerId = null;
    S.playerName = '';
    S.meta = null;
    S.draftQuestions = null;
    S.draftTitle = '';
    S.lastAnswer = null;
    S._qIndex = 0;
    render();
  }

  render();
})();
