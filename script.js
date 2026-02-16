/* --- IndexedDB Logic (unchanged, now used only for guests) --- */
const DB_NAME = "AISmartReaderDB";
const DB_VERSION = 1;
const STORE_NAME = "projects";
let idb;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject();
        request.onsuccess = (e) => { idb = e.target.result; resolve(); };
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
    });
}

async function getAllProjects() {
    if (currentUser) {
        const snapshot = await firestoreDb.collection(`users/${currentUser.uid}/projects`).get();
        // Remove any legacy 'notes' field from project documents
        return snapshot.docs.map(doc => {
            const data = doc.data();
            delete data.notes;
            return { id: doc.id, ...data };
        });
    } else {
        return new Promise((resolve) => {
            const transaction = idb.transaction([STORE_NAME], "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => {
                const projects = request.result || [];
                projects.forEach(p => { if (p.pinned === undefined) p.pinned = false; });
                resolve(projects);
            };
        });
    }
}

async function saveProjectToDB(project) {
    if (currentUser) {
        // Save only project fields (no notes) to Firestore
        const { notes, ...projectWithoutNotes } = project;
        await firestoreDb.collection(`users/${currentUser.uid}/projects`).doc(project.id.toString()).set(projectWithoutNotes);
    } else {
        return new Promise((resolve) => {
            const transaction = idb.transaction([STORE_NAME], "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            store.put(project);
            transaction.oncomplete = () => resolve();
        });
    }
}

async function deleteProjectFromDB(id) {
    if (currentUser) {
        // Delete all notes in sub‑collection first
        const notesRef = firestoreDb.collection(`users/${currentUser.uid}/projects/${id}/notes`);
        const snapshot = await notesRef.get();
        const batch = firestoreDb.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        // Then delete the project document
        await firestoreDb.collection(`users/${currentUser.uid}/projects`).doc(id.toString()).delete();
    } else {
        return new Promise((resolve) => {
            const transaction = idb.transaction([STORE_NAME], "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            store.delete(id);
            transaction.oncomplete = () => resolve();
        });
    }
}

/* --- Firebase Initialization (demo config – replace later) --- */
const firebaseConfig = {
  apiKey: "AIzaSyBC8Aw1k8-2eC6z3SE3uKGeRXh1c6whu-8",
  authDomain: "ai-smart-reader.firebaseapp.com",
  projectId: "ai-smart-reader",
  storageBucket: "ai-smart-reader.firebasestorage.app",
  messagingSenderId: "80394415958",
  appId: "1:80394415958:web:fa4602d5417d062e7330f7"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const firestoreDb = firebase.firestore();

/* --- Global Variables --- */
let currentUser = null;
let isGuestMode = true;
let migrationInProgress = false;

const textarea = document.getElementById('main-input');
const reader = document.getElementById('reader-view');
const panel = document.getElementById('right-panel');
const synth = window.speechSynthesis;

let currentProjectId = null, lastEn = "", lastBn = "", fontSize = 16, renameTarget = null, isNotebookVisible = false, currentBanglaAudio = null;
let currentSpeed = 1.0;

/* --- Auth State Observer --- */
auth.onAuthStateChanged(async (user) => {
    const wasLoggedIn = currentUser !== null;
    currentUser = user;
    isGuestMode = !user;

    updateAuthButton();

    if (user && !wasLoggedIn) {
        await migrateGuestProjects();
    } else if (!user && wasLoggedIn) {
        if (currentProjectId) {
            createNewProject();
        }
    }

    await renderProjects();
    await renderNotes();
});

/* --- Migration: copy guest projects (with notes) to Firestore sub‑collections --- */
async function migrateGuestProjects() {
    if (!currentUser) return;
    if (migrationInProgress) return;
    migrationInProgress = true;

    const loader = document.createElement('div');
    loader.id = 'migration-loader';
    loader.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); backdrop-filter:blur(3px); display:flex; align-items:center; justify-content:center; z-index:20000; color:white; font-size:1.2rem;';
    loader.innerHTML = '<div style="background:var(--surface); padding:20px; border-radius:12px;">⏳ Migrating projects...</div>';
    document.body.appendChild(loader);

    try {
        const guestProjects = await new Promise((resolve) => {
            const tx = idb.transaction([STORE_NAME], "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
        });

        if (guestProjects.length === 0) {
            migrationInProgress = false;
            loader.remove();
            return;
        }

        const snapshot = await firestoreDb.collection(`users/${currentUser.uid}/projects`).get();
        const existingIds = new Set(snapshot.docs.map(doc => doc.id));

        const batch = firestoreDb.batch();
        const projectsToMigrate = [];

        guestProjects.forEach(project => {
            const idStr = project.id.toString();
            if (!existingIds.has(idStr)) {
                const projectRef = firestoreDb.collection(`users/${currentUser.uid}/projects`).doc(idStr);
                const { notes, ...projectData } = project;
                batch.set(projectRef, projectData);
                projectsToMigrate.push({ id: idStr, notes: notes || [] });
            }
        });

        await batch.commit();

        // Migrate notes for each new project
        for (const { id, notes } of projectsToMigrate) {
            for (const note of notes) {
                await firestoreDb.collection(`users/${currentUser.uid}/projects/${id}/notes`).add({
                    en: note.en,
                    bn: note.bn,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            }
        }

        await new Promise((resolve) => {
            const tx = idb.transaction([STORE_NAME], "readwrite");
            const store = tx.objectStore(STORE_NAME);
            store.clear();
            tx.oncomplete = () => resolve();
        });

        console.log('Migration completed successfully');
    } catch (err) {
        console.error('Migration error:', err);
        alert('Failed to migrate your projects. Please try again.');
    } finally {
        migrationInProgress = false;
        loader.remove();
    }
}

/* --- Theme & UI Helpers (unchanged) --- */
function initTheme() {
    const settings = JSON.parse(localStorage.getItem('ai_reader_settings')) || { darkMode: true, eyeComfort: false };
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
    if (isNotebookVisible && reader.style.display === 'block') { nbPanel.style.display = 'block'; btn.classList.add('active'); }
    else { nbPanel.style.display = 'none'; btn.classList.remove('active'); }
}

function loadVoices() {
    const v = synth.getVoices().filter(x => x.lang.includes('en'));
    document.getElementById('voice-select').innerHTML = v.map(x => `<option value="${x.name}">${x.name}</option>`).join('');
}
if (synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;

function setSpeed(speed) {
    currentSpeed = speed;
    document.getElementById('speed-toggle-btn').innerText = `⚡ ${speed.toFixed(1)}x`;
    document.getElementById('speed-dropdown').classList.remove('active');
    document.getElementById('speed-toggle-btn').classList.remove('active');
}

function speak(text, mode) {
    synth.cancel();
    if (currentBanglaAudio) {
        currentBanglaAudio.pause();
        currentBanglaAudio = null;
    }
    if(mode === 'bn') {
        const ttsSpeed = currentSpeed > 1 ? 1 : currentSpeed; 
        const audioUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=bn&client=tw-ob&ttsspeed=${ttsSpeed}`;
        const audio = new Audio(audioUrl);
        audio.playbackRate = currentSpeed;
        currentBanglaAudio = audio;
        audio.onended = () => {
            if (currentBanglaAudio === audio) currentBanglaAudio = null;
        };
        audio.play().catch(e => console.error(e));
    } else {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = currentSpeed;
        u.voice = synth.getVoices().find(x => x.name === document.getElementById('voice-select').value);
        synth.speak(u);
    }
}

async function translateText(text) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=bn&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetch(url);
        const data = await res.json();
        return data[0].map(x => x[0]).join('');
    } catch (e) { return "Error."; }
}

async function handleNoteClick(word) {
    const regex = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    reader.innerHTML = textarea.value.replace(regex, '<span class="highlight-word">$1</span>');
    lastEn = word; panel.style.display = 'block';
    if(word.split(' ').length <= 3) {
        document.getElementById('syllable-section').style.display = 'block';
        document.getElementById('syllable-text').innerText = word.match(/[^aeiouy]*[aeiouy]+(?:[^aeiouy](?![aeiouy]))*/gi)?.join('·') || word;
    } else { document.getElementById('syllable-section').style.display = 'none'; }
    document.getElementById('trans-text').innerText = "Translating...";
    lastBn = await translateText(word);
    document.getElementById('trans-text').innerText = lastBn;
    document.querySelector('.highlight-word')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function toggleSidebar() { 
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('overlay').style.display = document.getElementById('sidebar').classList.contains('open') ? 'block' : 'none';
    renderProjects();
}

async function pinProject(id) {
    const projs = await getAllProjects();
    const project = projs.find(p => p.id == id);
    if (project) {
        project.pinned = !project.pinned;
        await saveProjectToDB(project);
        renderProjects();
    }
    closeAllMenus();
}

async function shareProject(id) {
    const projs = await getAllProjects();
    const project = projs.find(p => p.id == id);
    if (project && project.content) {
        try {
            await navigator.clipboard.writeText(project.content);
            alert('Project content copied to clipboard!');
        } catch (err) {
            alert('Could not copy content.');
        }
    } else {
        alert('No content to share.');
    }
    closeAllMenus();
}

async function renderProjects() {
    const projs = await getAllProjects();
    const sorted = [...projs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    
    document.getElementById('project-list').innerHTML = sorted.map(p => `
        <div class="project-item ${p.id == currentProjectId ? 'active' : ''}">
            <span onclick="loadProject(${p.id})" class="proj-name" style="cursor:pointer; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p.name} ${p.pinned ? '📌' : ''}</span>
            <span class="three-dots" onclick="toggleMenu(event, ${p.id})">⋮</span>
            <div class="action-menu" id="menu-${p.id}">
                <button onclick="openRename(${p.id})">✏️ Rename</button>
                <button onclick="pinProject(${p.id})">📌 ${p.pinned ? 'Unpin' : 'Pin'}</button>
                <button onclick="shareProject(${p.id})">🔗 Share</button>
                <button onclick="deleteProject(${p.id})" style="color:#ff5f5f">🗑️ Delete</button>
            </div>
        </div>
    `).join('');
    
    const activeProj = projs.find(p => p.id == currentProjectId);
    if(activeProj) {
        document.getElementById('active-proj-display').style.display = 'block';
        document.getElementById('active-proj-name').innerText = activeProj.name;
    } else {
        document.getElementById('active-proj-display').style.display = 'none';
    }
}

function closeAllMenus() {
    document.querySelectorAll('.action-menu').forEach(m => m.style.display = 'none');
    document.querySelectorAll('.project-item').forEach(item => item.classList.remove('menu-open'));
}

function toggleMenu(e, id) {
    e.stopPropagation();
    closeAllMenus();
    const menu = document.getElementById(`menu-${id}`);
    menu.style.display = 'flex';
    const projectItem = menu.closest('.project-item');
    if (projectItem) projectItem.classList.add('menu-open');
}

function openRename(id) { renameTarget = id; document.getElementById('rename-box').style.display = 'block'; document.getElementById('overlay').style.display = 'block'; }

async function confirmRename() {
    const name = document.getElementById('new-name-input').value.trim();
    if(!name) return;
    const projs = await getAllProjects();
    const p = projs.find(x => x.id == renameTarget);
    if(p) { p.name = name; await saveProjectToDB(p); }
    closeAll(); renderProjects();
}

async function deleteProject(id) {
    await deleteProjectFromDB(id);
    if(currentProjectId == id) currentProjectId = null;
    renderProjects();
}

async function loadProject(id) {
    const projs = await getAllProjects();
    let p = projs.find(x => x.id == id);
    currentProjectId = id; textarea.value = p.content; reader.innerText = p.content;
    document.getElementById('editor-view').style.display = 'none'; reader.style.display = 'block';
    if(isNotebookVisible) document.getElementById('left-notes-panel').style.display = 'block';
    document.getElementById('view-toggle').innerText = "✍️ Edit Mode";
    closeAll(); renderProjects(); renderNotes();
}

function createNewProject() { 
    currentProjectId = null; textarea.value = ""; 
    document.getElementById('editor-view').style.display = 'block'; reader.style.display = 'none';
    document.getElementById('left-notes-panel').style.display = 'none';
    document.getElementById('view-toggle').innerText = "📖 Read Mode";
    hidePanel(); closeAll(); renderProjects(); renderNotes(); 
}

/* --- Notes functions (adapted for sub‑collection) --- */

async function getNotesForProject(projectId) {
    if (!projectId) return [];
    if (currentUser) {
        const snapshot = await firestoreDb.collection(`users/${currentUser.uid}/projects/${projectId}/notes`).get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } else {
        const projects = await getAllProjects();
        const project = projects.find(p => p.id == projectId);
        return project?.notes || [];
    }
}

async function isNoteAdded(projectId, text) {
    if (!projectId) return false;
    if (currentUser) {
        const snapshot = await firestoreDb.collection(`users/${currentUser.uid}/projects/${projectId}/notes`)
            .where('en', '==', text).get();
        return !snapshot.empty;
    } else {
        const projects = await getAllProjects();
        const p = projects.find(x => x.id == projectId);
        return p?.notes?.some(n => n.en.trim().toLowerCase() === text.toLowerCase()) || false;
    }
}

async function addNote() {
    if (!currentProjectId || !lastEn) return;
    if (currentUser) {
        // Check if already added (though button should be disabled)
        if (await isNoteAdded(currentProjectId, lastEn)) return;
        await firestoreDb.collection(`users/${currentUser.uid}/projects/${currentProjectId}/notes`).add({
            en: lastEn,
            bn: lastBn,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    } else {
        const projects = await getAllProjects();
        let p = projects.find(x => x.id == currentProjectId);
        if (p) {
            if (!p.notes) p.notes = [];
            if (!p.notes.some(n => n.en.trim().toLowerCase() === lastEn.toLowerCase())) {
                p.notes.unshift({ en: lastEn, bn: lastBn });
                await saveProjectToDB(p);
            }
        }
    }
    renderNotes();
    const noteBtn = document.querySelector('.btn-note');
    noteBtn.innerHTML = "✅ Already Added";
    noteBtn.style.opacity = "0.7";
    noteBtn.style.pointerEvents = "none";
}

async function deleteNote(e, noteIdOrText) {
    e.stopPropagation();
    if (!currentProjectId) return;
    if (currentUser) {
        // noteIdOrText is the document ID
        await firestoreDb.collection(`users/${currentUser.uid}/projects/${currentProjectId}/notes`).doc(noteIdOrText).delete();
    } else {
        // noteIdOrText is the encoded English text
        const word = decodeURIComponent(noteIdOrText);
        const projects = await getAllProjects();
        let p = projects.find(x => x.id == currentProjectId);
        if (p) {
            p.notes = p.notes.filter(n => n.en.trim() !== word.trim());
            await saveProjectToDB(p);
        }
    }
    renderNotes();
}

async function renderNotes() {
    if (!currentProjectId) {
        document.getElementById('notes-container').innerHTML = '';
        return;
    }
    const notes = await getNotesForProject(currentProjectId);
    const html = notes.map(note => {
        if (currentUser) {
            // note has an id
            return `<div class="note-card" onclick="handleNoteClick('${note.en.replace(/'/g, "\\'")}')">
                <span class="delete-note" onclick="deleteNote(event, '${note.id}')">✕</span>
                <b style="font-size:13px;">${note.en.substring(0,30)}</b><br><small style="opacity:0.8;">${note.bn.substring(0,40)}</small>
            </div>`;
        } else {
            // guest: use encoded English as identifier
            return `<div class="note-card" onclick="handleNoteClick('${note.en.replace(/'/g, "\\'")}')">
                <span class="delete-note" onclick="deleteNote(event, '${encodeURIComponent(note.en)}')">✕</span>
                <b style="font-size:13px;">${note.en.substring(0,30)}</b><br><small style="opacity:0.8;">${note.bn.substring(0,40)}</small>
            </div>`;
        }
    }).join('');
    document.getElementById('notes-container').innerHTML = html;
}

/* --- View toggle with guest limit --- */
async function toggleView() {
    if (reader.style.display === 'none') {
        const content = textarea.value.trim(); if(!content) return;
        
        if (!currentUser) {
            const projects = await getAllProjects();
            if (projects.length >= 3) {
                alert('Guest users can only create up to 3 projects. Please log in to create more.');
                return;
            }
        }

        if (!currentProjectId) currentProjectId = Date.now();
        const projs = await getAllProjects();
        const existing = projs.find(p => p.id == currentProjectId);
        const projectData = existing ? { ...existing, content } : { id: currentProjectId, name: content.substring(0,20), content, pinned: false };
        // notes are not included – they are stored separately
        await saveProjectToDB(projectData);
        reader.innerText = content; document.getElementById('editor-view').style.display = 'none';
        reader.style.display = 'block'; if(isNotebookVisible) document.getElementById('left-notes-panel').style.display = 'block';
        document.getElementById('view-toggle').innerText = "✍️ Edit Mode"; renderProjects(); renderNotes();
    } else {
        document.getElementById('editor-view').style.display = 'block'; reader.style.display = 'none';
        document.getElementById('left-notes-panel').style.display = 'none';
        document.getElementById('view-toggle').innerText = "📖 Read Mode"; hidePanel();
    }
}

/* --- Mouseup event for selection --- */
document.addEventListener('mouseup', async () => {
    let s = window.getSelection().toString().trim();
    if (reader.style.display === 'block' && s.length > 0) {
        lastEn = s; panel.style.display = 'block';

        const added = await isNoteAdded(currentProjectId, s);
        const noteBtn = document.querySelector('.btn-note');
        if (added) {
            noteBtn.innerHTML = "✅ Already Added";
            noteBtn.style.opacity = "0.7";
            noteBtn.style.pointerEvents = "none";
        } else {
            noteBtn.innerHTML = "📝 Add to Notebook";
            noteBtn.style.opacity = "1";
            noteBtn.style.pointerEvents = "auto";
        }

        if(s.split(' ').length <= 3) {
            document.getElementById('syllable-section').style.display = 'block';
            document.getElementById('syllable-text').innerText = s.match(/[^aeiouy]*[aeiouy]+(?:[^aeiouy](?![aeiouy]))*/gi)?.join('·') || s;
        } else { document.getElementById('syllable-section').style.display = 'none'; }
        document.getElementById('trans-text').innerText = "Translating...";
        lastBn = await translateText(s); document.getElementById('trans-text').innerText = lastBn;
    }
});

function hidePanel() { 
    panel.style.display = 'none'; 
    const noteBtn = document.querySelector('.btn-note');
    noteBtn.innerHTML = "📝 Add to Notebook";
    noteBtn.style.opacity = "1";
    noteBtn.style.pointerEvents = "auto";
}

function closeAll() { 
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('overlay').style.display = 'none';
    document.getElementById('rename-box').style.display = 'none';
    closeAllMenus();
}

document.addEventListener('click', function(e) {
    if (!e.target.closest('.action-menu') && !e.target.closest('.three-dots')) {
        closeAllMenus();
    }
    const menu = document.getElementById('speed-dropdown');
    const btn = document.getElementById('speed-toggle-btn');
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
        menu.classList.remove('active');
        btn.classList.remove('active');
    }
});

function toggleSpeedMenu() {
    const menu = document.getElementById('speed-dropdown');
    const btn = document.getElementById('speed-toggle-btn');
    const isActive = menu.classList.contains('active');
    
    closeAllMenus();
    
    if (isActive) {
        menu.classList.remove('active');
        btn.classList.remove('active');
    } else {
        menu.classList.add('active');
        btn.classList.add('active');
    }
}

/* ===== AUTHENTICATION (Firebase) ===== */

function isLoggedIn() {
    return currentUser !== null;
}

function getCurrentUser() {
    return currentUser ? { email: currentUser.email } : null;
}

function updateAuthButton() {
    const btn = document.getElementById('auth-btn');
    btn.textContent = currentUser ? 'Logout' : 'Login';
}

async function logout() {
    try {
        await auth.signOut();
    } catch (err) {
        console.error('Logout error:', err);
    }
}

function toggleAuthModal() {
    if (currentUser) {
        logout();
    } else {
        openAuthModal();
    }
}

function openAuthModal() {
    document.getElementById('auth-overlay').style.display = 'block';
    document.getElementById('auth-modal').style.display = 'block';
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('signup-form').style.display = 'none';
    clearAuthErrors();
    clearAuthInputs();
}

function closeAuthModal() {
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('auth-modal').style.display = 'none';
}

function clearAuthErrors() {
    document.querySelectorAll('.error-message').forEach(el => el.textContent = '');
}

function clearAuthInputs() {
    document.getElementById('login-email').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('signup-email').value = '';
    document.getElementById('signup-password').value = '';
    document.getElementById('signup-confirm').value = '';
}

function switchToSignup() {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('signup-form').style.display = 'block';
    clearAuthErrors();
}

function switchToLogin() {
    document.getElementById('signup-form').style.display = 'none';
    document.getElementById('login-form').style.display = 'block';
    clearAuthErrors();
}

function togglePasswordVisibility(inputId, eyeElement) {
    const input = document.getElementById(inputId);
    if (input.type === 'password') {
        input.type = 'text';
        eyeElement.textContent = '🔒';
    } else {
        input.type = 'password';
        eyeElement.textContent = '👁️';
    }
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function handleLogin() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    let hasError = false;

    document.getElementById('login-email-error').textContent = '';
    document.getElementById('login-password-error').textContent = '';

    if (!email) {
        document.getElementById('login-email-error').textContent = 'Email is required';
        hasError = true;
    } else if (!isValidEmail(email)) {
        document.getElementById('login-email-error').textContent = 'Invalid email format';
        hasError = true;
    }

    if (!password) {
        document.getElementById('login-password-error').textContent = 'Password is required';
        hasError = true;
    }

    if (hasError) return;

    try {
        await auth.signInWithEmailAndPassword(email, password);
        closeAuthModal();
    } catch (error) {
        console.error(error);
        document.getElementById('login-password-error').textContent = error.message;
    }
}

async function handleSignup() {
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const confirm = document.getElementById('signup-confirm').value;
    let hasError = false;

    document.getElementById('signup-email-error').textContent = '';
    document.getElementById('signup-password-error').textContent = '';
    document.getElementById('signup-confirm-error').textContent = '';

    if (!email) {
        document.getElementById('signup-email-error').textContent = 'Email is required';
        hasError = true;
    } else if (!isValidEmail(email)) {
        document.getElementById('signup-email-error').textContent = 'Invalid email format';
        hasError = true;
    }

    if (!password) {
        document.getElementById('signup-password-error').textContent = 'Password is required';
        hasError = true;
    } else if (password.length < 6) {
        document.getElementById('signup-password-error').textContent = 'Password must be at least 6 characters';
        hasError = true;
    }

    if (!confirm) {
        document.getElementById('signup-confirm-error').textContent = 'Please confirm password';
        hasError = true;
    } else if (password !== confirm) {
        document.getElementById('signup-confirm-error').textContent = 'Passwords do not match';
        hasError = true;
    }

    if (hasError) return;

    try {
        await auth.createUserWithEmailAndPassword(email, password);
        closeAuthModal();
    } catch (error) {
        console.error(error);
        document.getElementById('signup-password-error').textContent = error.message;
    }
}

/* --- Real Google Sign-In --- */
async function handleGoogleLogin() {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
        await auth.signInWithPopup(provider);
        closeAuthModal();
    } catch (error) {
        console.error(error);
        alert(error.message);
    }
}

/* --- Real Password Reset --- */
async function forgotPassword() {
    const email = document.getElementById('login-email').value.trim();
    if (!email) {
        alert('Please enter your email address.');
        return;
    }
    if (!isValidEmail(email)) {
        alert('Please enter a valid email address.');
        return;
    }
    try {
        await auth.sendPasswordResetEmail(email);
        alert('Password reset email sent. Check your inbox.');
    } catch (error) {
        console.error(error);
        alert(error.message);
    }
}

/* --- Initialize everything on page load --- */
window.onload = async () => {
    await initDB();
    initTheme();
    loadVoices();
    await renderProjects();
    await renderNotes();
};