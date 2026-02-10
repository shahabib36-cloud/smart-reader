const textarea = document.getElementById('main-input');
const reader = document.getElementById('reader-view');
const panel = document.getElementById('right-panel');
const synth = window.speechSynthesis;

let currentProjectId = null, lastEn = "", lastBn = "", fontSize = 22, renameTarget = null, isNotebookVisible = false;

// --- ১. Firebase Auth & UI Update ---
const authBtn = document.getElementById('auth-btn');

// Auth State Monitor: এটি চেক করবে ইউজার লগইন আছে কি না
auth.onAuthStateChanged(user => {
    if (user) {
        authBtn.innerText = 'Logout';
        authBtn.style.borderColor = '#ff5f5f';
        renderProjects(); // লগইন থাকলে ডাটাবেস থেকে প্রজেক্ট লোড হবে
    } else {
        authBtn.innerText = 'Login';
        authBtn.style.borderColor = 'var(--accent)';
        document.getElementById('project-list').innerHTML = ""; 
        document.getElementById('notes-container').innerHTML = "";
    }
});

// Google Login
document.getElementById('google-login').addEventListener('click', () => {
    auth.signInWithPopup(googleProvider).then(() => {
        closeAuthModal();
    }).catch(err => alert(err.message));
});

// Email Login/Register
document.getElementById('main-auth-action').addEventListener('click', () => {
    const email = document.getElementById('auth-email').value;
    const pass = document.getElementById('auth-pass').value;
    if(!email || !pass) return alert("Email and Password required");

    if(isLoginMode) {
        auth.signInWithEmailAndPassword(email, pass).catch(err => alert(err.message));
    } else {
        auth.createUserWithEmailAndPassword(email, pass).catch(err => alert(err.message));
    }
    closeAuthModal();
});

authBtn.addEventListener('click', () => {
    if (auth.currentUser) auth.signOut();
    else { closeAll(); openAuthModal(); }
});

// --- ২. Firestore Data Sync (সেভ এবং লোড) ---

async function toggleView() {
    if (reader.style.display === 'none') {
        const content = textarea.value.trim(); 
        if(!content) return;
        
        const user = auth.currentUser;
        if (user) {
            const id = currentProjectId || Date.now().toString();
            // Firestore-এ প্রজেক্ট সেভ করা
            await db.collection("users").doc(user.uid).collection("projects").doc(id).set({
                id: id,
                name: content.substring(0,20),
                content: content,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            currentProjectId = id;
        }

        reader.innerText = textarea.value; 
        document.getElementById('editor-view').style.display = 'none'; 
        reader.style.display = 'block';
        document.getElementById('view-toggle').innerText = "✍️ Edit Mode";
        if(user) renderProjects();
    } else {
        document.getElementById('editor-view').style.display = 'block'; 
        reader.style.display = 'none';
        document.getElementById('view-toggle').innerText = "📖 Read Mode";
        hidePanel();
    }
}

function renderProjects() {
    const user = auth.currentUser;
    if (!user) return;

    // Firestore থেকে রিয়েল-টাইম প্রজেক্ট লিস্ট আনা
    db.collection("users").doc(user.uid).collection("projects").orderBy("timestamp", "desc")
    .onSnapshot(snapshot => {
        document.getElementById('project-list').innerHTML = snapshot.docs.map(doc => {
            const p = doc.data();
            return `
                <div class="project-item ${p.id === currentProjectId ? 'active' : ''}">
                    <span onclick="loadProject('${p.id}')" style="cursor:pointer; flex:1;">${p.name}</span>
                    <span class="three-dots" onclick="toggleMenu(event, '${p.id}')">⋮</span>
                    <div class="action-menu" id="menu-${p.id}">
                        <button onclick="openRename('${p.id}')">Rename</button>
                        <button onclick="deleteProject('${p.id}')" style="color:#ff5f5f">Delete</button>
                    </div>
                </div>`;
        }).join('');
    });
}

async function loadProject(id) {
    const user = auth.currentUser;
    const doc = await db.collection("users").doc(user.uid).collection("projects").doc(id).get();
    if (doc.exists) {
        const p = doc.data();
        currentProjectId = id;
        textarea.value = p.content;
        reader.innerText = p.content;
        document.getElementById('editor-view').style.display = 'none';
        reader.style.display = 'block';
        document.getElementById('view-toggle').innerText = "✍️ Edit Mode";
        closeAll();
        renderNotes();
    }
}

async function addNote() {
    const user = auth.currentUser;
    if (user && currentProjectId) {
        await db.collection("users").doc(user.uid).collection("projects").doc(currentProjectId)
        .collection("notes").add({
            en: lastEn,
            bn: lastBn,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        checkNoteStatus(lastEn);
    }
}

function renderNotes() {
    const user = auth.currentUser;
    if (!user || !currentProjectId) return;

    db.collection("users").doc(user.uid).collection("projects").doc(currentProjectId)
    .collection("notes").orderBy("timestamp", "desc").onSnapshot(snapshot => {
        document.getElementById('notes-container').innerHTML = snapshot.docs.map(doc => {
            const n = doc.data();
            return `
                <div class="note-card" onclick="handleNoteClick(\`${n.en.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`)">
                    <span class="delete-note" onclick="deleteNoteFromDb(event, '${doc.id}')">✕</span>
                    <span class="note-title">${n.en}</span>
                    <span class="note-sub">${n.bn}</span>
                </div>`;
        }).join('');
    });
}

async function deleteNoteFromDb(e, noteId) {
    e.stopPropagation();
    const user = auth.currentUser;
    await db.collection("users").doc(user.uid).collection("projects").doc(currentProjectId)
    .collection("notes").doc(noteId).delete();
}

async function deleteProject(id) {
    if(confirm("Delete this project?")) {
        const user = auth.currentUser;
        await db.collection("users").doc(user.uid).collection("projects").doc(id).delete();
        if(currentProjectId === id) createNewProject();
    }
}

async function confirmRename() {
    const name = document.getElementById('new-name-input').value.trim();
    if(!name || !renameTarget) return;
    const user = auth.currentUser;
    await db.collection("users").doc(user.uid).collection("projects").doc(renameTarget).update({ name: name });
    closeAll();
}

// --- ৩. আগের সিস্টেম (Voice, Translate, UI) - অপরিবর্তিত ---

function initTheme() {
    const settings = JSON.parse(localStorage.getItem('ai_reader_settings')) || { darkMode: false, eyeComfort: false };
    document.getElementById('dark-mode-toggle').checked = settings.darkMode;
    document.body.classList.toggle('light-mode', !settings.darkMode);
    document.getElementById('eye-comfort-toggle').checked = settings.eyeComfort;
    document.body.classList.toggle('eye-comfort', settings.eyeComfort);
}

function updateThemeSettings() {
    const darkMode = document.getElementById('dark-mode-toggle').checked;
    const eyeComfort = document.getElementById('eye-comfort-toggle').checked;
    localStorage.setItem('ai_reader_settings', JSON.stringify({ darkMode, eyeComfort }));
    document.body.classList.toggle('light-mode', !darkMode);
    document.body.classList.toggle('eye-comfort', eyeComfort);
}

function changeFontSize(d) { fontSize += d; reader.style.fontSize = fontSize + 'px'; }

function toggleNotebook() {
    isNotebookVisible = !isNotebookVisible;
    const nbPanel = document.getElementById('left-notes-panel');
    const btn = document.getElementById('nb-toggle-btn');
    if (isNotebookVisible) { nbPanel.style.display = 'block'; btn.classList.add('active'); renderNotes(); }
    else { nbPanel.style.display = 'none'; btn.classList.remove('active'); }
}

function loadVoices() {
    const v = synth.getVoices().filter(x => x.lang.includes('en'));
    document.getElementById('voice-select').innerHTML = v.map(x => `<option value="${x.name}">${x.name}</option>`).join('');
}
if (synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;

function speak(text, mode) {
    synth.cancel();
    const speed = parseFloat(document.getElementById('speed-select').value);
    if(mode === 'bn') {
        const audioUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=bn&client=tw-ob&ttsspeed=${speed}`;
        new Audio(audioUrl).play();
    } else {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = speed;
        u.voice = synth.getVoices().find(x => x.name === document.getElementById('voice-select').value);
        synth.speak(u);
    }
}

async function translateText(text) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=bn&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetch(url);
        const data = await res.json();
        return data[0].map(part => part[0]).join('');
    } catch (e) { return "Translation error."; }
}

async function handleNoteClick(word) {
    reader.innerText = textarea.value; 
    const text = reader.innerText;
    const index = text.toLowerCase().indexOf(word.toLowerCase().trim());
    if (index !== -1) {
        const originalText = text.substring(index, index + word.length);
        const escapedWord = originalText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedWord})`, 'gi');
        reader.innerHTML = reader.innerHTML.replace(regex, '<span class="highlight-word">$1</span>');
        const target = document.querySelector('.highlight-word');
        if(target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    lastEn = word; panel.style.display = 'block'; checkNoteStatus(word);
    document.getElementById('trans-text').innerText = "Translating...";
    lastBn = await translateText(word);
    document.getElementById('trans-text').innerText = lastBn;
}

// ... বাকি ছোট ফাংশনগুলো (toggleSidebar, toggleMenu, openRename, closeAll, createNewProject) ঠিক থাকবে
function toggleSidebar() { 
    const isOpen = document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('overlay').style.display = isOpen ? 'block' : 'none';
}
function toggleMenu(e, id) { e.stopPropagation(); document.querySelectorAll('.action-menu').forEach(m => m.style.display = 'none'); document.getElementById(`menu-${id}`).style.display = 'flex'; }
function openRename(id) { renameTarget = id; document.getElementById('rename-box').style.display = 'block'; document.getElementById('overlay').style.display = 'block'; }
function createNewProject() { currentProjectId = null; textarea.value = ""; reader.innerText = ""; toggleView(); closeAll(); }
function hidePanel() { panel.style.display = 'none'; }
function closeAll() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('overlay').style.display = 'none'; document.getElementById('rename-box').style.display = 'none'; document.querySelectorAll('.action-menu').forEach(m => m.style.display = 'none'); }
function openAuthModal() { document.getElementById('auth-modal').style.display = 'block'; document.getElementById('overlay').style.display = 'block'; }
function closeAuthModal() { document.getElementById('auth-modal').style.display = 'none'; document.getElementById('overlay').style.display = 'none'; }

let isLoginMode = true;
document.getElementById('toggle-auth-mode').addEventListener('click', (e) => {
    e.preventDefault();
    isLoginMode = !isLoginMode;
    document.getElementById('modal-title').innerText = isLoginMode ? 'Login' : 'Register';
    document.getElementById('main-auth-action').innerText = isLoginMode ? 'Login' : 'Register';
    document.getElementById('toggle-auth-mode').innerText = isLoginMode ? "Register" : "Login";
});

document.addEventListener('mouseup', async () => {
    let s = window.getSelection().toString().trim();
    if (reader.style.display === 'block' && s.length > 0) {
        lastEn = s; panel.style.display = 'block'; checkNoteStatus(s);
        lastBn = await translateText(s); document.getElementById('trans-text').innerText = lastBn;
    }
});

function checkNoteStatus(word) {
    const btn = document.getElementById('add-note-btn');
    btn.innerHTML = "📝 Add to Notebook"; btn.disabled = false;
}

window.onload = () => { loadVoices(); initTheme(); };