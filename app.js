// OPTISCHEDULE: the whole dashboard in one file
//   1. page behavior (greeting, tabs)
//   2. the screens (storage, forms, lists; the scheduling logic itself is in engine.js)
//   3. Firebase (sign-in check, load and save the user's data)
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import {
    DAY_NAMES, formatClock, formatHour, hourPreference,
    prettyDate, scheduleDay, toISO, weeklySchedule
} from "./engine.js";

// ================= 1. PAGE BEHAVIOR =================
// GREETING: for the time of the person
function updateGreeting() {
    const hour = new Date().getHours(); // 0 to 23

    let message;
    if (hour >= 5 && hour < 12) {
        message = "Good Morning!";     
    } else if (hour >= 12 && hour < 17) {
        message = "Good Afternoon!";    
    } else {
        message = "Good Evening!";     
    }

    document.getElementById("greeting").textContent = message;
}

updateGreeting();
setInterval(updateGreeting, 60000); // checks again every minute

// TABS
const tabs = document.querySelectorAll(".tab");
const dropdowns = document.querySelectorAll(".dropdown");
const startHeading = document.getElementById("Start");

// "Start With" only shows while the Today card is open
function updateStartHeading() {
    const todayOpen = document.getElementById("today").classList.contains("open");
    startHeading.style.display = todayOpen ? "" : "none";
}

tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
        const panel = document.getElementById(tab.dataset.panel);
        const wasOpen = panel.classList.contains("open");

        // close everything first
        tabs.forEach(function (t) { t.classList.remove("active"); });
        dropdowns.forEach(function (d) { d.classList.remove("open"); });

        // open the one you clicked also second click closes it
        if (!wasOpen) {
            tab.classList.add("active");
            panel.classList.add("open");
        }

        updateStartHeading();
    });
});

updateStartHeading();

// ================= 2. SCREENS =================

// ---------- STORAGE ----------
// Your data lives in Firestore (see section 3), one document per signed-in user.
// localStorage is only used for the "popup shown today" flag, and to import data
// saved by the older offline version of the app.
function load(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

const CLOUD_FIELDS = {
    hwLimits: "limits",
    hwSubjects: "subjects",
    hwAssignments: "assignments",
    hwSessions: "sessions"
};

function save(key, value) {
    if (CLOUD_FIELDS[key]) {
        saveToCloud(CLOUD_FIELDS[key], value);
        return;
    }
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        // storage blocked: the app still works, it just won't remember
    }
}

// limits: bedtime/wake are hours (0-23)
//   weekly = repeating blocks (work shift every Saturday)
//   dates  = blocks on one date only (doctor appointment on Oct 20)
let limits = { bedtime: 20, wake: 7, weekly: [], dates: [] };
let subjects = [];        // ["Math", "English"]
let assignments = [];     // { id, subject, title, due: "2026-10-20", minutes }
let sessions = [];        // { hour, minutes, date }

// fills the four lists above from the cloud document (or from old offline data)
function initState(data) {
    limits = data.limits || { bedtime: 20, wake: 7 };
    limits.weekly = limits.weekly || limits.busy || [];   // older saves called these "busy"
    limits.dates = limits.dates || [];
    subjects = data.subjects || [];
    assignments = data.assignments || [];
    sessions = data.sessions || [];
}

// ---------- SMALL DOM HELPERS ----------
function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;   // textContent = safe for typed labels
    if (className) node.className = className;
    return node;
}

function $(id) {
    return document.getElementById(id);
}

function makeButton(text, onClick, extraClass) {
    const btn = el("button", text, "small-btn" + (extraClass ? " " + extraClass : ""));
    btn.addEventListener("click", onClick);
    return btn;
}

function fillSelect(select, from, to, labelFor) {
    for (let v = from; v <= to; v++) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = labelFor(v);
        select.appendChild(opt);
    }
}

function goToTab(panelId) {
    const tab = document.querySelector('.tab[data-panel="' + panelId + '"]');
    if (tab && !tab.classList.contains("active")) tab.click();
}

// ---------- SCREEN: TODAY ----------
let finishing = null;   // the assignment shown in the "how long did it take?" popup

// "Get started" steps, shown until all three are done
function renderChecklist() {
    const box = $("checklist");
    box.replaceChildren();

    const steps = [
        { done: subjects.length > 0, text: "Add a subject (a class you have homework in)", tab: "assignments" },
        { done: assignments.length > 0, text: "Add an assignment with a due date", tab: "plan" },
        { done: limits.configured === true, text: "Set your sleep and any times you can't work", tab: "settings", skip: true }
    ];
    if (steps.every(function (st) { return st.done; })) return;

    const card = el("div", undefined, "checklist");
    card.appendChild(el("h4", "Get started in 3 steps"));
    steps.forEach(function (st, i) {
        const row = el("div", undefined, st.done ? "step done" : "step");
        row.appendChild(el("span", st.done ? "\u2713" : String(i + 1), "step-mark"));
        row.appendChild(el("span", st.text, "step-text"));
        if (!st.done) row.appendChild(makeButton("Go", function () { goToTab(st.tab); }, "ghost"));
        if (!st.done && st.skip) {
            row.appendChild(makeButton("Defaults are fine", function () {
                limits.configured = true;
                save("hwLimits", limits);
                renderAll();
            }, "ghost"));
        }
        card.appendChild(row);
    });
    box.appendChild(card);
}

// why the engine picked this hour
function reasonFor(hour) {
    const pref = hourPreference(sessions);
    if (pref.learned.indexOf(hour) !== -1) return "one of your fastest times";
    if (hour >= 15 && hour <= 19) return "afternoon, until I learn your best time";
    return "first free time today";
}

function renderToday() {
    renderChecklist();

    const box = $("todayList");
    box.replaceChildren();
    $("todaySummary").textContent = "";

    const now = new Date();
    const todayISO = toISO(now);
    const due = assignments
        .filter(function (a) { return a.due <= todayISO; })     // due today, or overdue
        .sort(function (a, b) { return a.due < b.due ? -1 : 1; });

    if (due.length === 0) {
        if (assignments.length === 0) {
            box.appendChild(el("p", "You haven't added any homework yet.", "empty-title"));
            box.appendChild(el("p", "Add an assignment and I'll pick the best time to do it.", "note"));
            const needsSubject = subjects.length === 0;
            box.appendChild(makeButton(
                needsSubject ? "Add a subject first" : "Add an assignment",
                function () { goToTab(needsSubject ? "assignments" : "plan"); },
                "primary"
            ));
        } else {
            const next = assignments.slice().sort(function (a, b) { return a.due < b.due ? -1 : 1; })[0];
            box.appendChild(el("p", "Nothing is due today.", "empty-title"));
            box.appendChild(el("p", "Next up: " + next.title + " (" + next.subject + "), due " + prettyDate(next.due) + ".", "note"));
            box.appendChild(makeButton("Add another assignment", function () { goToTab("plan"); }, "primary"));
        }
        return;
    }

    const totalMinutes = due.reduce(function (sum, a) { return sum + a.minutes; }, 0);
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    $("todaySummary").textContent =
        due.length + (due.length === 1 ? " assignment" : " assignments") + ", about " +
        (hours ? hours + "h " : "") + (mins || !hours ? mins + "m" : "") + " of work. Do them in this order.";

    const placed = scheduleDay(limits, sessions, todayISO, now.getHours() + 1, due);
    placed.forEach(function (p) {
        const a = p.item;
        const isOverdue = a.due < todayISO;
        const row = el("div", undefined, isOverdue ? "item-row overdue" : "item-row");

        const main = el("div", undefined, "item-main");
        main.appendChild(el("span", a.title));
        main.appendChild(makeButton("Done", function () { showFinishPopup(a); }, "primary"));
        row.appendChild(main);

        const when = p.hour === null
            ? "No free time left today. Move the due date or free up time in Settings."
            : formatClock(p.hour * 60) + " - " + formatClock(p.hour * 60 + a.minutes) + "  (" + reasonFor(p.hour) + ")";
        const overdue = isOverdue ? "  |  overdue, was due " + prettyDate(a.due) : "";
        row.appendChild(el("div", a.subject + "  |  " + when + overdue, p.hour === null || isOverdue ? "item-sub warn" : "item-sub"));

        box.appendChild(row);
    });
}

// "Done" opens a popup asking how long it really took, and the engine learns from that
function showFinishPopup(a) {
    finishing = a;
    $("finishTitle").textContent = a.title + " (" + a.subject + ")";
    $("finishMinutes").value = a.minutes;
    $("finishPopup").classList.add("open");
    $("finishMinutes").focus();
    $("finishMinutes").select();
}

function hideFinishPopup() {
    finishing = null;
    $("finishPopup").classList.remove("open");
}

function saveFinishPopup() {
    if (finishing) finishAssignment(finishing, Number($("finishMinutes").value));
}

function finishAssignment(a, minutes) {
    if (!minutes || minutes < 1) {
        alert("Enter a number of minutes.");
        return;
    }
    const startedAt = new Date(Date.now() - minutes * 60000);
    sessions.push({ hour: startedAt.getHours(), minutes: minutes, date: new Date().toISOString() });
    assignments = assignments.filter(function (x) { return x.id !== a.id; });
    hideFinishPopup();
    save("hwSessions", sessions);
    save("hwAssignments", assignments);
    renderAll();
}

// ---------- SCREEN: PLAN ----------
function renderPlan() {
    const select = $("planSubject");
    const previous = select.value;
    select.replaceChildren();
    subjects.forEach(function (s) {
        const opt = el("option", s);
        opt.value = s;
        select.appendChild(opt);
    });
    if (subjects.indexOf(previous) !== -1) select.value = previous;

    $("planHint").textContent = subjects.length === 0
        ? "You need a subject first. Add one in the Subjects tab."
        : "";

    const list = $("planList");
    list.replaceChildren();
    if (assignments.length === 0) {
        list.appendChild(el("p", "Nothing added yet.", "note"));
        return;
    }

    assignments
        .slice()
        .sort(function (a, b) { return a.due < b.due ? -1 : 1; })
        .forEach(function (a) {
            const row = el("div", undefined, "item-row");
            const main = el("div", undefined, "item-main");
            main.appendChild(el("span", a.title));
            main.appendChild(makeButton("Remove", function () {
                assignments = assignments.filter(function (x) { return x.id !== a.id; });
                save("hwAssignments", assignments);
                renderAll();
            }, "ghost"));
            row.appendChild(main);
            row.appendChild(el("div", a.subject + "  |  due " + prettyDate(a.due) + "  |  " + a.minutes + " min", "item-sub"));
            list.appendChild(row);
        });
}

// ---------- SCREEN: SUBJECTS ----------
function renderSubjects() {
    const list = $("subjectList");
    list.replaceChildren();
    if (subjects.length === 0) {
        list.appendChild(el("p", "No subjects yet. Try Math or English.", "note"));
        return;
    }
    subjects.forEach(function (name) {
        const row = el("div", undefined, "item-row");
        const main = el("div", undefined, "item-main");
        main.appendChild(el("span", name));
        main.appendChild(makeButton("Remove", function () {
            subjects = subjects.filter(function (s) { return s !== name; });
            assignments = assignments.filter(function (a) { return a.subject !== name; });
            save("hwSubjects", subjects);
            save("hwAssignments", assignments);
            renderAll();
        }, "ghost"));
        row.appendChild(main);
        list.appendChild(row);
    });
}

// ---------- SCREEN: SETTINGS ----------
function renderBlockList(listId, blocks, describe) {
    const list = $(listId);
    list.replaceChildren();
    if (blocks.length === 0) {
        list.appendChild(el("p", "Nothing added yet.", "note"));
        return;
    }
    blocks.forEach(function (b, i) {
        const row = el("div", undefined, "busy-row");
        row.appendChild(el("span", describe(b)));
        row.appendChild(makeButton("Remove", function () {
            blocks.splice(i, 1);
            save("hwLimits", limits);
            renderAll();
        }, "ghost"));
        list.appendChild(row);
    });
}

function renderSettings() {
    $("bedtime").value = limits.bedtime;
    $("wake").value = limits.wake;

    renderBlockList("weeklyList", limits.weekly, function (b) {
        return b.label + " - every " + DAY_NAMES[b.day] + " " + formatHour(b.start) + " to " + formatHour(b.end);
    });
    renderBlockList("dateList", limits.dates, function (b) {
        return b.label + " - " + prettyDate(b.date) + " " + formatHour(b.start) + " to " + formatHour(b.end);
    });
}

// ---------- WEEKLY POPUP ----------
function renderWeekPopup() {
    const list = $("weekList");
    list.replaceChildren();

    weeklySchedule(limits, sessions).forEach(function (entry, i) {
        const name = i === 0 ? "Today" : DAY_NAMES[entry.date.getDay()];
        const row = el("div", undefined, entry.best ? "week-row" : "week-row na");
        row.appendChild(el("span", name, "week-day"));
        const text = entry.best
            ? formatHour(entry.best.hour) + " (about " + entry.best.minutes + " min)" + (entry.best.known ? "" : " - untried")
            : "Not available";
        row.appendChild(el("span", text));
        list.appendChild(row);
    });
}

function showWeekPopup() {
    renderWeekPopup();
    $("weekPopup").classList.add("open");
}

function hideWeekPopup() {
    $("weekPopup").classList.remove("open");
}

function renderAll() {
    renderToday();
    renderPlan();
    renderSubjects();
    renderSettings();
    renderWeekPopup();
}

// ---------- WIRING ----------
const hourLabel = function (h) { return formatHour(h); };

fillSelect($("bedtime"), 0, 23, hourLabel);
fillSelect($("wake"), 0, 23, hourLabel);
fillSelect($("weeklyStart"), 0, 23, hourLabel);
fillSelect($("weeklyEnd"), 1, 24, hourLabel);
fillSelect($("dateStart"), 0, 23, hourLabel);
fillSelect($("dateEnd"), 1, 24, hourLabel);
fillSelect($("weeklyDay"), 0, 6, function (d) { return DAY_NAMES[d]; });

$("weeklyStart").value = 9;
$("weeklyEnd").value = 17;
$("dateStart").value = 15;
$("dateEnd").value = 16;
$("planDue").value = toISO(new Date());
$("dateValue").value = toISO(new Date());

$("bedtime").addEventListener("change", function (e) {
    limits.bedtime = Number(e.target.value);
    limits.configured = true;
    save("hwLimits", limits);
    renderAll();
});

$("wake").addEventListener("change", function (e) {
    limits.wake = Number(e.target.value);
    limits.configured = true;
    save("hwLimits", limits);
    renderAll();
});

$("addWeekly").addEventListener("click", function () {
    const start = Number($("weeklyStart").value);
    const end = Number($("weeklyEnd").value);
    if (end <= start) {
        alert("The end time has to be after the start time.");
        return;
    }
    limits.weekly.push({
        label: $("weeklyLabel").value.trim() || "Blocked",
        day: Number($("weeklyDay").value),
        start: start,
        end: end
    });
    limits.configured = true;
    save("hwLimits", limits);
    $("weeklyLabel").value = "";
    renderAll();
});

$("addDate").addEventListener("click", function () {
    const start = Number($("dateStart").value);
    const end = Number($("dateEnd").value);
    if (!$("dateValue").value) {
        alert("Pick a date.");
        return;
    }
    if (end <= start) {
        alert("The end time has to be after the start time.");
        return;
    }
    limits.dates.push({
        label: $("dateLabel").value.trim() || "Blocked",
        date: $("dateValue").value,
        start: start,
        end: end
    });
    limits.configured = true;
    save("hwLimits", limits);
    $("dateLabel").value = "";
    renderAll();
});

$("addSubject").addEventListener("click", function () {
    const name = $("subjectName").value.trim();
    if (!name) return;
    if (subjects.indexOf(name) === -1) subjects.push(name);
    save("hwSubjects", subjects);
    $("subjectName").value = "";
    renderAll();
});

$("addAssignment").addEventListener("click", function () {
    if (subjects.length === 0) {
        alert("Add a subject in the Subjects tab first.");
        return;
    }
    const title = $("planTitle").value.trim();
    const minutes = Number($("planMinutes").value);
    if (!title || !$("planDue").value || !minutes || minutes < 5) {
        alert("Fill in the name, due date, and minutes (5 or more).");
        return;
    }
    assignments.push({
        id: Date.now() + Math.random(),
        subject: $("planSubject").value,
        title: title,
        due: $("planDue").value,
        minutes: minutes
    });
    save("hwAssignments", assignments);
    $("planTitle").value = "";
    renderAll();
});

$("saveFinish").addEventListener("click", saveFinishPopup);
$("cancelFinish").addEventListener("click", hideFinishPopup);
$("finishMinutes").addEventListener("keydown", function (e) {
    if (e.key === "Enter") saveFinishPopup();
});
$("finishPopup").addEventListener("click", function (e) {
    if (e.target === this) hideFinishPopup();   // click on the dark area closes it
});
document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { hideFinishPopup(); hideWeekPopup(); }
});

$("closePopup").addEventListener("click", hideWeekPopup);
$("openWeek").addEventListener("click", showWeekPopup);
$("weekPopup").addEventListener("click", function (e) {
    if (e.target === this) hideWeekPopup();   // click on the dark area closes it
});

// called once the user is signed in and their data has loaded
function startApp(cloudData) {
    if (cloudData) {
        initState(cloudData);
    } else {
        // first time on this account: bring over anything saved by the offline version
        initState({
            limits: load("hwLimits", null),
            subjects: load("hwSubjects", []),
            assignments: load("hwAssignments", []),
            sessions: load("hwSessions", [])
        });
        save("hwLimits", limits);
        save("hwSubjects", subjects);
        save("hwAssignments", assignments);
        save("hwSessions", sessions);
    }

    renderAll();

    // the weekly popup shows once per day when the app starts
    if (load("hwPopupDate", "") !== new Date().toDateString()) {
        save("hwPopupDate", new Date().toDateString());
        showWeekPopup();
    }
}

// ================= 3. FIREBASE =================
let userRef = null;   // this user's Firestore document: users/{uid}

function setStatus(text, isError) {
    $("syncStatus").textContent = text;
    $("syncStatus").classList.toggle("error", Boolean(isError));
}

function saveToCloud(field, value) {
    if (!userRef) return;
    setStatus("Saving...");
    setDoc(userRef, { [field]: value }, { merge: true }).then(
        function () { setStatus("All changes saved"); },
        function (e) {
            console.error(e);
            setStatus("Couldn't save. Check your connection.", true);
        }
    );
}

$("signOut").addEventListener("click", function () {
    signOut(auth).then(function () { location.replace("index.html"); });
});

onAuthStateChanged(auth, async function (user) {
    if (!user) {
        location.replace("index.html");   // signed-out visitors go to the login page
        return;
    }

    userRef = doc(db, "users", user.uid);
    $("userEmail").textContent = user.email || "";

    try {
        const snap = await getDoc(userRef);
        startApp(snap.exists() ? snap.data() : null);
        setStatus("All changes saved");
    } catch (e) {
        console.error(e);
        setStatus("Couldn't load your data.", true);
        startApp({});
    }
    document.body.classList.remove("loading");
});
