import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { requireWithin, runSmoke } from "./smoke-arc-windows.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const selector = (css) => `document.querySelector(${JSON.stringify(css)})`;
const button = (label, within = "document") =>
  `[...${within}.querySelectorAll('button,a,summary')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled&&e.checkVisibility()&&e.getBoundingClientRect().width>0)`;

async function until(label, probe, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let failure;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      failure = error;
    }
    await delay(150);
  }
  throw Error(
    `${label} did not complete${failure ? `: ${failure.message}` : ""}`,
  );
}

export async function verifyTeamBuilderUi(context, options = {}) {
  const withModelPicker =
    options.withModelPicker ?? !!options.templateExecution;
  const {
    debuggerClient,
    baseUrl,
    root,
    saved,
    daemon,
    pass,
    check,
    captureRenderer,
  } = context;
  assert.equal(new URL(baseUrl).hostname, "127.0.0.1");
  const artifacts = requireWithin(root, join(root, `team-ui-pass-${pass + 1}`));
  await mkdir(artifacts, { recursive: true });
  const report = {
    status: "running",
    checks: [],
    screenshots: [],
    limitations: [
      "Duplicate live Send is not exercised here; this helper never dispatches a provider turn.",
    ],
    input:
      "Native Electron mouse/keyboard; HTML drag payload captured from the actual draggable palette",
  };
  const record = (name) => {
    report.checks.push(name);
    check(`Team UI pass ${pass + 1}: ${name}`);
  };
  const request = async (
    path,
    body,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json();
    assert(
      response.ok,
      `${path}: HTTP ${response.status}: ${JSON.stringify(value).slice(0, 1500)}`,
    );
    return value;
  };
  const rpc = async (method, input) => {
    const value = await request(`/plugins/arc/rpc/${method}`, input);
    assert.equal(
      value.ok,
      true,
      `${method}: ${JSON.stringify(value).slice(0, 1500)}`,
    );
    return value.result;
  };
  const contents = `process.mainModule.require('electron').webContents.getAllWebContents().find(c=>c.getURL().startsWith(${JSON.stringify(baseUrl + "/")}))`;
  const native = async (body) => {
    const result = await debuggerClient.evaluate(
      `(async()=>{const c=${contents};if(!c)throw Error('Owned renderer missing');${body}})()`,
    );
    assert(
      !result.exceptionDetails,
      `Native input failed: ${JSON.stringify(result.exceptionDetails)}`,
    );
    assert(
      !result.result?.subtype || result.result.subtype !== "error",
      result.result?.description,
    );
    return result.result.value;
  };
  const renderer = async (expression) => {
    try {
      return await native(
        `return c.executeJavaScript(${JSON.stringify(expression)});`,
      );
    } catch (error) {
      throw new Error(`Renderer expression failed: ${expression}`, {
        cause: error,
      });
    }
  };
  const visible = (expression) =>
    renderer(
      `(()=>{const e=${expression};return !!e&&e.checkVisibility()&&e.getBoundingClientRect().width>0&&!e.closest('[inert],[aria-hidden=true]');})()`,
    );
  const point = (expression, x = 0.5, y = 0.5) =>
    renderer(
      `(()=>{const e=${expression};if(!e)throw Error('Missing UI target');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();if(!e.checkVisibility()||!r.width||!r.height||e.disabled)throw Error('UI target unavailable');return {x:Math.round(r.x+r.width*${x}),y:Math.round(r.y+r.height*${y})};})()`,
    );
  const clickAt = async (p) =>
    native(
      `const w=process.mainModule.require('electron').BrowserWindow.fromWebContents(c);const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));if(w.isMinimized())w.restore();w.show();w.focus();c.focus();await wait(150);if(!w.isFocused()||!c.isFocused())throw Error('Owned desktop window did not receive native focus: '+JSON.stringify({visible:w.isVisible(),minimized:w.isMinimized(),focused:w.isFocused(),contentsFocused:c.isFocused()}));c.sendInputEvent({type:'mouseMove',...${JSON.stringify(p)}});await wait(40);c.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...${JSON.stringify(p)}});await wait(40);c.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...${JSON.stringify(p)}});return true;`,
    );
  const click = async (expression) => {
    await until("visible control", () => visible(expression));
    let previous;
    const target = await until("stable clickable control", async () => {
      const current = await point(expression);
      const reachable = await renderer(
        `(${expression}).contains(document.elementFromPoint(${current.x},${current.y}))`,
      );
      const stable = previous?.x === current.x && previous?.y === current.y;
      previous = current;
      return reachable && stable ? current : false;
    });
    await clickAt(target);
  };
  const openDetails = async (label) => {
    const summary = button(label);
    if (!(await renderer(`(${summary})?.closest('details')?.open`)))
      await click(summary);
    await until(`opened ${label}`, () =>
      renderer(`(${summary})?.closest('details')?.open===true`),
    );
  };
  const key = async (keyCode, modifiers = []) => {
    const character =
      modifiers.length === 0
        ? keyCode === "Return" || keyCode === "Enter"
          ? "\r"
          : keyCode === "Space"
            ? " "
            : null
        : null;
    await native(
      `c.sendInputEvent({type:'keyDown',keyCode:${JSON.stringify(keyCode)},modifiers:${JSON.stringify(modifiers)}});${character === null ? "" : `c.sendInputEvent({type:'char',keyCode:${JSON.stringify(character)},modifiers:[]});`}c.sendInputEvent({type:'keyUp',keyCode:${JSON.stringify(keyCode)},modifiers:${JSON.stringify(modifiers)}});return true;`,
    );
    await delay(40);
  };
  const type = (text) =>
    native(`c.insertText(${JSON.stringify(text)});return true;`);
  const fill = async (expression, text) => {
    await click(expression);
    await key("A", ["control"]);
    await type(text);
    await key("Tab");
    await until("typed field value", () =>
      renderer(`(${expression})?.value===${JSON.stringify(text)}`),
    );
  };
  const select = async (css, value) => {
    const expression = selector(css);
    const index = await renderer(
      `(()=>{const e=${expression};return e?[...e.options].findIndex(o=>o.value===${JSON.stringify(value)}):-1;})()`,
    );
    assert(index >= 0, `Missing select option ${value} in ${css}`);
    await click(expression);
    await key("Home");
    for (let i = 0; i < index; i++) await key("Down");
    await key("Return");
    await key("Tab");
    await until("native select change", () =>
      renderer(`(${expression})?.value===${JSON.stringify(value)}`),
    );
  };
  const release = () =>
    debuggerClient.evaluate(
      "(async()=>{await globalThis.__arcSmokeRendererDiagnostics?.release();return true;})()",
    );
  const startMentionDiagnostics = async () => {
    await release();
    await native(`
      if(c.debugger.isAttached())throw Error('Renderer debugger still occupied');
      c.debugger.attach('1.3');
      const rows=[],requests=new Map(),pending=new Set(),base=${JSON.stringify(baseUrl)};
      const listener=(_event,method,params)=>{
        if(method==='Network.responseReceived'&&params.response.url.startsWith(base+'/api/v1/')){
          const url=new URL(params.response.url),entry={path:url.pathname+url.search,status:params.response.status};
          if(rows.length<150)rows.push(entry);
          if(entry.status>=400||url.pathname==='/api/v1/plugins/mentions/search'||url.pathname.endsWith('/paths')||url.pathname.endsWith('/detail-bootstrap'))requests.set(params.requestId,entry);
        }
        if(method==='Network.loadingFailed'&&rows.length<150)rows.push({loadingFailed:params.errorText,canceled:params.canceled});
        if(method==='Network.loadingFinished'&&requests.has(params.requestId)){
          const entry=requests.get(params.requestId);requests.delete(params.requestId);
          const work=c.debugger.sendCommand('Network.getResponseBody',{requestId:params.requestId}).then(body=>{entry.body=body.base64Encoded?'[binary]':body.body.slice(0,16000);},error=>{entry.bodyError=String(error);});
          pending.add(work);work.finally(()=>pending.delete(work));
        }
      };
      c.debugger.on('message',listener);
      globalThis.__arcTeamUiNetwork={c,listener,rows,pending};
      await c.debugger.sendCommand('Network.enable');return true;
    `);
  };
  const stopMentionDiagnostics = async () => {
    const rows = await native(`
      const diagnostic=globalThis.__arcTeamUiNetwork;if(!diagnostic)return null;
      await Promise.allSettled([...diagnostic.pending]);
      diagnostic.c.debugger.removeListener('message',diagnostic.listener);
      if(diagnostic.c.debugger.isAttached())diagnostic.c.debugger.detach();
      delete globalThis.__arcTeamUiNetwork;return diagnostic.rows;
    `);
    if (rows) report.mentionRequests = rows;
  };
  const capture = async (name) => {
    const path = requireWithin(artifacts, join(artifacts, `${name}.png`));
    await captureRenderer(debuggerClient, baseUrl, path);
    await release();
    report.screenshots.push(path);
  };
  const navigate = async (path) => {
    await native(
      `await c.loadURL(${JSON.stringify(baseUrl + path)});return true;`,
    );
    await until("loaded application", () =>
      renderer("document.readyState==='complete'"),
    );
    await renderer(`(()=>{
      window.__arcTeamUiInput=[];
      for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{
        const target=event.target.closest('button,input,select,summary');
        window.__arcTeamUiInput.push({type,trusted:event.isTrusted,x:event.clientX,y:event.clientY,tag:target?.tagName,label:target?.getAttribute('aria-label'),text:target?.tagName==='BUTTON'?target.textContent.slice(0,100):null});
        if(window.__arcTeamUiInput.length>20)window.__arcTeamUiInput.shift();
      },true);
      return true;
    })()`);
  };
  const drag = async (from, to, html = false) => {
    const start = await point(from);
    const end = typeof to === "string" ? await point(to) : to;
    await release();
    const result = await native(`
      const start=${JSON.stringify(start)},end=${JSON.stringify(end)};
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      let data=null;
      const listener=(_event,method,params)=>{if(method==='Input.dragIntercepted')data=params.data;};
      if(${html}){if(c.debugger.isAttached())throw Error('Renderer debugger still occupied');c.debugger.attach('1.3');c.debugger.on('message',listener);await c.debugger.sendCommand('Input.setInterceptDrags',{enabled:true});}
      try{
        c.focus();c.sendInputEvent({type:'mouseMove',...start});
        c.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...start});
        await wait(80);
        for(let step=1;step<=16;step++){
          c.sendInputEvent({type:'mouseMove',button:'left',buttons:1,x:Math.round(start.x+(end.x-start.x)*step/16),y:Math.round(start.y+(end.y-start.y)*step/16)});
          await wait(24);
          if(data)break;
        }
        if(${html}){
          for(let i=0;i<30&&!data;i++)await wait(25);
          if(!data)throw Error('Native palette drag did not produce a browser drag payload');
          for(const type of ['dragEnter','dragOver','drop'])await c.debugger.sendCommand('Input.dispatchDragEvent',{type,...end,data});
        }
        c.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...end});
        return {start,end,html:${html},mimeTypes:data?.items?.map(item=>item.mimeType)??[]};
      }finally{
        c.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...end});
        if(${html}){await c.debugger.sendCommand('Input.setInterceptDrags',{enabled:false});c.debugger.removeListener('message',listener);c.debugger.detach();}
      }
    `);
    report.drags ??= [];
    report.drags.push(result);
    if (html)
      assert(
        result.mimeTypes.includes("application/x-arc-agent"),
        "Palette drag did not carry ARC's real agent payload",
      );
  };
  const scope = { kind: "project", projectId: saved.project.id };
  const listPath = `/plugins/arc/teams/project/${saved.project.id}`;
  const canvas = selector('[aria-label="Team organization canvas"]');
  const graph = selector('[aria-label="Team graph"]');
  const palette = selector('[aria-label="Published agent palette"]');
  const layout = () =>
    renderer(`(()=>{
      const inspect=selector=>{const e=document.querySelector(selector);if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,x:r.x,y:r.y,display:s.display,visibility:s.visibility,hiddenAncestor:!!e.closest('[inert],[aria-hidden=true]')};};
      const active=document.activeElement;
      return {url:location.pathname,viewport:{width:innerWidth,height:innerHeight,scale:devicePixelRatio},activeElement:active?{tag:active.tagName,label:active.getAttribute('aria-label'),text:active.textContent.trim().slice(0,160),draggable:active.draggable}:null,builder:inspect('[data-arc-team-builder]'),palette:inspect('[aria-label="Published agent palette"]'),canvas:inspect('[aria-label="Team organization canvas"]'),inspector:inspect('[aria-label="Member inspector"]'),controls:[...document.querySelectorAll('button,summary,select')].filter(e=>e.getBoundingClientRect().width>0).slice(0,100).map(e=>({tag:e.tagName,label:e.getAttribute('aria-label'),text:e.textContent.trim().slice(0,160),disabled:!!e.disabled})),paletteEntries:[...document.querySelectorAll('[aria-label="Published agent palette"] button')].map(e=>({text:e.innerText,draggable:e.draggable,disabled:e.disabled,width:e.getBoundingClientRect().width}))};
    })()`);
  const ensurePaletteCanvas = async (verifyCompact) => {
    report.layoutBeforePalette = await layout();
    if (!(await visible(palette))) {
      await click(button("Agent library", selector("[data-arc-team-builder]")));
      await until("opened agent library", () => visible(palette));
    }
    if (!(await visible(canvas))) {
      if (verifyCompact) {
        report.compactLibrary = await layout();
        await capture("compact-agent-library");
        await verifyCompact();
        if (!(await visible(palette))) {
          await click(
            button("Agent library", selector("[data-arc-team-builder]")),
          );
          await until("reopened compact library", () => visible(palette));
        }
      }
      await click(selector('button[aria-label^="Hide right panel"]'));
    }
    await until(
      "visible agent library and drag destination",
      async () => (await visible(palette)) && (await visible(canvas)),
    );
    report.layoutWithPalette = await layout();
  };
  const memberNode = (id) =>
    selector(
      `[aria-label="Team organization canvas"] .react-flow__node[data-id="${id}"]`,
    );
  let oldBounds;
  let fixtureThread;
  let fixture;
  try {
    await release();
    oldBounds = await native(
      "const w=process.mainModule.require('electron').BrowserWindow.fromWebContents(c);const before=w.getBounds();w.setContentSize(1760,1050);return before;",
    );
    if (pass > 0) {
      const previous = JSON.parse(
        await readFile(
          requireWithin(root, join(root, "team-ui-fixture.json")),
          "utf8",
        ),
      );
      const current = (await rpc("getTeam", { scope, teamId: previous.teamId }))
        .team;
      assert.deepEqual(current.draft.definition, previous.definition);
      await navigate(`${listPath}/${current.id}`);
      await until("restored team canvas", () => visible(canvas));
      assert.equal(
        await renderer(
          `document.querySelectorAll('[aria-label="Team organization canvas"] .react-flow__node').length`,
        ),
        previous.definition.members.length,
      );
      await navigate(
        `/projects/${saved.project.id}/threads/${previous.threadId}`,
      );
      await until("restored work recipients", () =>
        visible(selector('[aria-label="Work recipients"]')),
      );
      assert.equal(
        await renderer(
          "document.querySelectorAll('[aria-label=\"Work recipients\"] button').length",
        ),
        2,
      );
      assert.equal(
        (
          await request(
            `/threads/${previous.threadId}/events?types=turn%2Finput%2Faccepted&limit=1`,
          )
        ).length,
        0,
      );
      await capture("persisted-recipients");
      record(
        "Packaged restart retained exact team draft, pinned skills and both work recipients without provider dispatch",
      );
      report.status = "passed";
      return;
    }
    const templates = await rpc("listTeamTemplates", null);
    assert(
      templates.templates.some(
        (template) =>
          template.id === "efficient-build" && template.version === 1,
      ),
    );
    const inherited = (
      await rpc("saveAgentSkillBundle", {
        files: [
          {
            path: "SKILL.md",
            executable: false,
            contentBase64: Buffer.from(
              "---\nname: ui-inherited-skill\ndescription: Use during isolated UI acceptance.\n---\n\nKeep this inherited skill pinned.\n",
            ).toString("base64"),
          },
        ],
      })
    ).skill;
    const agents = [];
    for (const role of ["Lead", "Reader"]) {
      const metadata = {
        schemaVersion: 2,
        name: `UI ${role} ${saved.token.slice(0, 8)}`,
        description: "Owned packaged UI fixture",
        specialty: "",
        role,
        execution: {
          providerId: null,
          model: null,
          reasoningLevel: null,
          serviceTier: null,
          permissionMode: null,
        },
        skills:
          role === "Reader" ? [{ id: inherited.id, name: inherited.name }] : [],
      };
      let { agent } = await rpc("createAgent", {
        scope,
        document: `---\n${JSON.stringify(metadata)}\n---\n\nRead-only UI fixture; no work is dispatched.\n`,
      });
      ({ agent } = await rpc("publishAgentRevision", {
        scope,
        agentId: agent.id,
        expectedDraftVersion: agent.draft.version,
      }));
      agents.push({
        id: agent.id,
        name: metadata.name,
        revision: agent.currentRevision,
      });
    }
    await navigate(listPath);
    await until("bundled team template", () =>
      visible(selector('[aria-label="Built-in team templates"]')),
    );
    assert(
      await renderer(
        "document.querySelector('[aria-label=\"Built-in team templates\"]').innerText.includes('Efficient Build')",
      ),
    );
    await click(button("Use this team"));
    await until("template setup", () =>
      visible(selector('[aria-label="Template project"]')),
    );
    assert.equal(
      await renderer(
        "document.querySelector('[aria-label=\"Template project\"]').value",
      ),
      saved.project.id,
    );
    record(
      "Efficient Build catalog and project setup are available before provider execution",
    );
    await click(button("Close setup"));
    let name = `UI Team ${saved.token.slice(0, 8)}`;
    await fill(selector('[aria-label="New team name"]'), name);
    await click(button("Create team"));
    fixture = await until("created team", async () =>
      (await rpc("listTeams", { scope, search: name })).teams.find(
        (team) => team.name === name,
      ),
    );
    const target = { scope, teamId: fixture.id };
    const draft = () =>
      renderer(
        `JSON.parse(localStorage.getItem(${JSON.stringify(`arc.teamDraft.${fixture.id}`)})??'null')?.definition`,
      );
    const waitDraft = (label, predicate) =>
      until(label, async () => {
        const value = await draft();
        return value && predicate(value) ? value : false;
      });
    await until("new team canvas", () => visible(canvas));
    for (let i = 0; i < agents.length; i++) {
      const item = `[...document.querySelectorAll('[aria-label="Published agent palette"] button[draggable="true"]')].find(e=>e.innerText.includes(${JSON.stringify(agents[i].name)}))`;
      await ensurePaletteCanvas(
        i === 0
          ? async () => {
              const search = selector(
                '[aria-label="Find an agent for this team"]',
              );
              await fill(search, agents[i].name);
              await until("filtered compact agent", () => visible(item));
              await click(search);
              await key("Tab");
              assert(
                await renderer(`document.activeElement===(${item})`),
                "The compact palette entry was not reachable from its search field with Tab",
              );
              await key("Return");
              await waitDraft(
                "compact keyboard member addition",
                (value) =>
                  value.members.length === 1 &&
                  value.members[0].agentId === agents[i].id,
              );
              await until("compact member inspector", () =>
                visible(selector('[aria-label="Member team role"]')),
              );
              await capture("compact-keyboard-member-add");
              await click(
                button("Team", selector('[aria-label="Team builder views"]')),
              );
              await key("Z", ["control"]);
              await waitDraft(
                "compact addition undo",
                (value) => value.members.length === 0,
              );
              await click(
                button("Agent library", selector("[data-arc-team-builder]")),
              );
              await fill(search, "");
              record(
                "Default split layout exposes a searchable agent library; Tab/Enter adds a pinned agent and opens its inspector, and keyboard Undo restores the empty team",
              );
            }
          : undefined,
      );
      await until("published agent palette entry", () => visible(item));
      await drag(item, await point(canvas, i === 0 ? 0.2 : 0.67, 0.25), true);
      await waitDraft(
        "palette drop member",
        (value) => value.members.length === i + 1,
      );
    }
    const initial = await draft();
    const leader = initial.members.find(
      (member) => member.agentId === agents[0].id,
    ).id;
    const reader = initial.members.find(
      (member) => member.agentId === agents[1].id,
    ).id;
    assert.equal(initial.graph.nodes.length, 0);
    const position = initial.presentation.members.find(
      (member) => member.memberId === reader,
    );
    const from = await point(memberNode(reader));
    await drag(memberNode(reader), { x: from.x + 45, y: from.y + 70 });
    await waitDraft("native member movement", (value) => {
      const after = value.presentation.members.find(
        (member) => member.memberId === reader,
      );
      return after.x !== position.x || after.y !== position.y;
    });
    record(
      "Native palette drags added pinned agents and native canvas drag persisted member movement without adding workflow stages",
    );
    await select('[aria-label="Relationship type"]', "reports-to");
    await openDetails("Connect agents with the keyboard");
    await select('[aria-label="Relationship source"]', reader);
    await select('[aria-label="Relationship target"]', leader);
    await click(button("Connect agents"));
    await waitDraft(
      "reports-to relationship",
      (value) =>
        value.members.find((member) => member.id === reader).leaderMemberId ===
        leader,
    );
    assert.deepEqual((await draft()).permissions, []);
    assert(
      await renderer(
        "[...document.querySelectorAll('.react-flow__edge-text')].some(e=>e.textContent==='Reports to')",
      ),
    );
    await click(memberNode(reader));
    await key("Z", ["control"]);
    await waitDraft(
      "keyboard undo",
      (value) =>
        value.members.find((member) => member.id === reader).leaderMemberId ===
        null,
    );
    await key("Y", ["control"]);
    await waitDraft(
      "keyboard redo",
      (value) =>
        value.members.find((member) => member.id === reader).leaderMemberId ===
        leader,
    );
    assert.deepEqual((await draft()).permissions, []);
    record(
      "Keyboard connection creates child-to-leader Reports to; Ctrl+Z/Ctrl+Y restore hierarchy without expanding permissions",
    );
    await select('[aria-label="Relationship type"]', "message");
    const bothWays = `[...document.querySelectorAll('[data-arc-team-builder] label')].find(e=>e.textContent.trim()==='Both ways')?.querySelector('input[type="checkbox"]')`;
    if (await renderer(`(${bothWays})?.checked`)) await click(bothWays);
    assert.equal(await renderer(`(${bothWays})?.checked`), false);
    await drag(
      selector(`[aria-label="Connect from ${agents[0].name}"]`),
      selector(`[aria-label="Connect to ${agents[1].name}"]`),
    );
    await waitDraft(
      "directional native handle connection",
      (value) =>
        value.permissions.length === 1 &&
        value.permissions[0].action === "message" &&
        value.permissions[0].fromMemberId === leader &&
        value.permissions[0].toMemberId === reader,
    );
    assert.equal(
      await renderer(
        "document.querySelector('[aria-label=\"Visible connections\"]').value",
      ),
      "message",
    );
    await click(memberNode(reader));
    await fill(selector('[aria-label="Member team role"]'), "Evidence owner");
    await fill(
      selector('[aria-label="Member responsibility"]'),
      "Read only the assigned files and give source-linked evidence.",
    );
    assert(
      await renderer(
        "document.querySelector('[aria-label=\"Assigned skills\"]').innerText.includes('ui-inherited-skill')&&document.querySelector('[aria-label=\"Assigned skills\"]').innerText.includes('From agent')",
      ),
    );
    await click(button("Create skill"));
    await fill(selector('[aria-label="Skill name"]'), "ui-extra-skill");
    await fill(
      selector('[aria-label="When to use this skill"]'),
      "Use when checking the owned UI fixture.",
    );
    await fill(
      selector('[aria-label="Skill instructions"]'),
      "Read references/checklist.md. Report each observed check and preserve the inherited skill.",
    );
    await fill(
      selector('[aria-label="New supporting file path"]'),
      "references/checklist.md",
    );
    await click(button("Add file"));
    const supporting =
      "# UI checklist\n\n- Verify the actual canvas and pinned skill.\n";
    await fill(
      selector('[aria-label="Contents of references/checklist.md"]'),
      supporting,
    );
    await click(button("SKILL.md"));
    await click(button("Edit raw Markdown"));
    await until("rendered standard skill Markdown", () =>
      renderer(
        "document.querySelector('[aria-label=\"Skill Markdown\"]')?.value.includes('name: ui-extra-skill')",
      ),
    );
    await click(button("Guided editor"));
    await until("restored guided skill fields", () =>
      renderer(
        "document.querySelector('[aria-label=\"Skill name\"]')?.value==='ui-extra-skill'",
      ),
    );
    await click(button("Save skill and assign"));
    const assigned = await waitDraft(
      "team-specific skill assignment",
      (value) =>
        value.members.find((member) => member.id === reader).skills.length ===
        1,
    );
    const extra = assigned.members.find((member) => member.id === reader)
      .skills[0];
    const bundle = (await rpc("readAgentSkillBundle", { id: extra.id })).skill;
    assert.equal(
      Buffer.from(
        bundle.files.find((file) => file.path === "references/checklist.md")
          .contentBase64,
        "base64",
      ).toString(),
      supporting,
    );
    const originalAgent = (
      await rpc("getAgentRevision", {
        scope,
        agentId: agents[1].id,
        revision: agents[1].revision,
      })
    ).revision;
    assert.deepEqual(originalAgent.metadata.skills, [
      { id: inherited.id, name: inherited.name },
    ]);
    await capture("guided-skills-and-team");
    record(
      "Guided skill, raw Markdown round-trip and support-file editing produce a pinned member addition while agent defaults remain immutable",
    );
    await click(button("Add a task"));
    await until("cross-view selected stage", () =>
      visible(selector('[aria-label="Stage name"]')),
    );
    await fill(selector('[aria-label="Stage name"]'), "Read UI fixture");
    await fill(
      selector('[aria-label="Assignment"]'),
      "Read the owned fixture and return source-linked evidence. Do not edit files.",
    );
    await select('[aria-label="Work type"]', "read");
    const withTask = await waitDraft(
      "assigned workflow stage",
      (value) =>
        value.graph.nodes.length === 1 &&
        value.graph.nodes[0].memberId === reader &&
        value.graph.nodes[0].access === "read",
    );
    const stage = withTask.graph.nodes[0];
    await click(button("Team", selector('[aria-label="Team builder views"]')));
    await click(memberNode(reader));
    await click(
      button("Read UI fixture", selector('[aria-label="Member inspector"]')),
    );
    assert.equal(
      await renderer(
        "document.querySelector('[aria-label=\"Stage name\"]').value",
      ),
      "Read UI fixture",
    );
    const workflowNode = selector(
      `[aria-label="Team graph"] .react-flow__node[data-id="stage:${stage.id}"]`,
    );
    await click(workflowNode);
    await key("Delete");
    await waitDraft(
      "keyboard stage deletion",
      (value) => value.graph.nodes.length === 0 && value.members.length === 2,
    );
    await click(
      button("Workflow", selector('[aria-label="Team builder views"]')),
    );
    await key("Z", ["control"]);
    await waitDraft(
      "keyboard stage restoration",
      (value) =>
        value.graph.nodes.length === 1 && value.graph.nodes[0].id === stage.id,
    );
    await capture("linked-workflow");
    record(
      "Member task action and assigned-work navigation select the same Workflow stage; keyboard Delete/Undo preserve team membership",
    );
    await select('[aria-label="Stage type"]', "approval");
    await click(button("Add stage"));
    await fill(selector('[aria-label="Stage name"]'), "Confirm evidence");
    await fill(
      selector('[aria-label="What should the user approve?"]'),
      "Confirm the read-only evidence is sufficient before completing this run.",
    );
    await click(
      `[...document.querySelectorAll('[aria-label="Stage inspector"] label')].find(e=>e.textContent.trim()==='Required before this run can succeed').querySelector('input')`,
    );
    const gated = await waitDraft(
      "required approval stage",
      (value) => value.graph.requiredGates.length === 1,
    );
    const approval = gated.graph.nodes.find((node) => node.kind === "approval");
    assert(approval);
    await openDetails("Connect stages with the keyboard");
    await select('[aria-label="Connection source"]', stage.id);
    await select('[aria-label="Connection target"]', approval.id);
    await click(button("Connect"));
    await waitDraft("keyboard workflow connection", (value) =>
      value.graph.edges.some(
        (edge) => edge.source === stage.id && edge.target === approval.id,
      ),
    );
    record(
      "Keyboard workflow connection preserves a required user approval after the read-only stage",
    );
    await click(button("Team", selector('[aria-label="Team builder views"]')));
    await ensurePaletteCanvas();
    await select('[aria-label="Agent palette source"]', "library");
    const library = (
      await rpc("listAgents", {
        scope: { kind: "library" },
        search: "Efficient Build",
      })
    ).agents;
    const reusable = library.find(
      (agent) => agent.name === "Efficient Build · Reader",
    );
    assert(
      reusable,
      "Fresh packaged library is missing Efficient Build Reader",
    );
    const reusableBefore = (
      await rpc("getAgentRevision", {
        scope: { kind: "library" },
        agentId: reusable.id,
        revision: reusable.currentRevision,
      })
    ).revision;
    const reusableButton = `[...document.querySelectorAll('[aria-label="Published agent palette"] button[draggable="true"]')].find(e=>e.innerText.includes('Efficient Build · Reader'))`;
    await until("bundled draggable agent", () => visible(reusableButton));
    await drag(reusableButton, await point(canvas, 0.55, 0.7), true);
    const copied = await waitDraft(
      "editable project copy",
      (value) => value.members.length === 3,
    );
    const copiedMember = copied.members.find(
      (member) => ![leader, reader].includes(member.id),
    );
    assert.notEqual(copiedMember.agentId, reusable.id);
    const copiedAgent = (
      await rpc("getAgentRevision", {
        scope,
        agentId: copiedMember.agentId,
        revision: copiedMember.revision,
      })
    ).revision;
    assert.deepEqual(
      copiedAgent.metadata.skills,
      reusableBefore.metadata.skills,
    );
    await fill(
      selector('[aria-label="Member team role"]'),
      "Project-specific reader",
    );
    assert.deepEqual(
      (
        await rpc("getAgentRevision", {
          scope: { kind: "library" },
          agentId: reusable.id,
          revision: reusable.currentRevision,
        })
      ).revision,
      reusableBefore,
    );
    record(
      "Dragging a bundled Reader creates an editable project copy with inherited pinned skills and preserves the library revision",
    );
    name += " Studio";
    await fill(selector('[aria-label="Team name"]'), name);
    await click(button("Set color"));
    await renderer(`(()=>{
      const input=document.querySelector('[aria-label="Team color"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'#8b5cf6');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    })()`);
    await waitDraft(
      "team identity controls",
      (value) => value.name === name && value.presentation.color === "#8b5cf6",
    );
    if (withModelPicker) {
      await click(
        `(${memberNode(copiedMember.id)}).querySelector('button[aria-label^="Change model"]')`,
      );
      await click(
        selector('[aria-label="Member model"] button[aria-haspopup]'),
      );
      const codexTab = `[...document.querySelectorAll('button[title="Codex"]')].find(e=>e.checkVisibility())`;
      if (await visible(codexTab)) await click(codexTab);
      const modelSearch = selector('[aria-label="Search models"]');
      const astraOption = `[...document.querySelectorAll('button')].find(e=>/^(?:GPT[- ]?)?6[- ]Astra$/i.test(e.innerText.trim())&&e.checkVisibility())`;
      await until(
        "loaded model choices",
        async () =>
          (await visible(modelSearch)) || (await visible(astraOption)),
      );
      if (await visible(modelSearch)) await fill(modelSearch, "astra");
      await click(astraOption);
      await key("Escape");
      await click(button("Apply model"));
      await waitDraft(
        "member model selection",
        (value) =>
          value.members.find((member) => member.id === copiedMember.id)
            ?.modelOverride?.model === "gpt-6-astra",
      );
      await until("provider logo and selected model on canvas", () =>
        renderer(`(()=>{
      const node=${memberNode(copiedMember.id)};
      return node?.innerText.includes('gpt-6-astra') && !!node.querySelector('[role="img"][aria-label="Codex"]') && node.querySelector('.arc-team-stage').style.getPropertyValue('--arc-team-color') === '#8b5cf6';
    })()`),
      );
    }
    await capture(
      withModelPicker ? "team-name-color-model" : "team-name-color",
    );
    assert.deepEqual(
      (
        await rpc("getAgentRevision", {
          scope,
          agentId: copiedMember.agentId,
          revision: copiedMember.revision,
        })
      ).revision,
      copiedAgent,
    );
    record(
      withModelPicker
        ? "Team toolbar name, DOM-driven native color input, and canvas model button update the draft; native model picker selects Astra with its provider logo without changing the pinned agent"
        : "Team toolbar name and DOM-driven native color input update the draft without changing the pinned agent",
    );
    await click(button("Save draft"));
    const persisted = await until("saved canonical UI draft", async () => {
      const team = (await rpc("getTeam", target)).team;
      return team.draft.definition.members.length === 3 ? team : false;
    });
    assert(persisted.validation.valid, JSON.stringify(persisted.validation));
    await click(button("Publish version"));
    const published = await until("published UI team", async () => {
      const team = (await rpc("getTeam", target)).team;
      return team.currentRevision !== null ? team : false;
    });
    report.team = {
      id: published.id,
      revision: published.currentRevision,
      definition: published.draft.definition,
    };
    await navigate(`${listPath}/${fixture.id}`);
    await until("saved canvas after reload", () => visible(canvas));
    assert.equal(
      await renderer(
        "document.querySelector('[aria-label=\"Team name\"]').value",
      ),
      name,
    );
    assert.equal(
      await renderer(
        "document.querySelector('[aria-label=\"Team color\"]').value",
      ),
      "#8b5cf6",
    );
    if (withModelPicker)
      await until("saved model after reload", () =>
        renderer(
          `(${memberNode(copiedMember.id)}).innerText.includes('gpt-6-astra')`,
        ),
      );
    assert.equal(
      await renderer(
        "document.querySelectorAll('[aria-label=\"Team organization canvas\"] .react-flow__node').length",
      ),
      3,
    );
    await capture("published-team");
    if (options.templateExecution) {
      const checkCommand = {
        executable: join(
          process.env.SystemRoot ?? "C:/Windows",
          "System32",
          "cmd.exe",
        ),
        args: ["/d", "/c", "exit", "0"],
        timeoutMs: 1000,
      };
      const configuration = {
        roles: Object.fromEntries(
          ["lead", "reader", "builder", "reviewer"].map((role) => [
            role,
            options.templateExecution,
          ]),
        ),
        check: checkCommand,
      };
      const first = await rpc("instantiateTeamTemplate", {
        templateId: "efficient-build",
        version: 1,
        projectId: saved.project.id,
        operationId: `ui-template-${randomUUID()}`,
        configuration,
      });
      const firstBefore = first.team.draft.definition;
      await navigate(listPath);
      await click(button("Use this team"));
      await until("saved template choices", () =>
        renderer(
          'document.body.innerText.includes("Using this project\'s saved model choices")',
        ),
      );
      await click(button("Create project team"));
      const newTeam = await until(
        "UI-created template project copy",
        async () => {
          const url = await renderer("location.pathname");
          const id = url.split("/").at(-1);
          return id.startsWith("team_") && id !== first.team.id
            ? (await rpc("getTeam", { scope, teamId: id })).team
            : false;
        },
      );
      assert.notEqual(newTeam.id, first.team.id);
      assert(
        newTeam.draft.definition.members.every(
          (member) =>
            !firstBefore.members.some(
              (prior) => prior.agentId === member.agentId,
            ),
        ),
      );
      await until("new template canvas", () => visible(canvas));
      assert.equal(
        await renderer(
          "document.querySelector('[aria-label=\"Visible connections\"]').value",
        ),
        "reports-to",
      );
      const hierarchyCount = newTeam.draft.definition.members.filter(
        (member) => member.leaderMemberId != null,
      ).length;
      const visibleEdges = () =>
        renderer(
          "document.querySelectorAll('[aria-label=\"Team organization canvas\"] .react-flow__edge').length",
        );
      await until(
        "hierarchy-only default canvas",
        async () => (await visibleEdges()) === hierarchyCount,
      );
      await select('[aria-label="Visible connections"]', "all");
      await until(
        "all retained template connections",
        async () =>
          (await visibleEdges()) ===
          hierarchyCount + newTeam.draft.definition.permissions.length,
      );
      await select('[aria-label="Visible connections"]', "reports-to");
      await until(
        "restored readable hierarchy",
        async () => (await visibleEdges()) === hierarchyCount,
      );
      assert.deepEqual(
        (await rpc("getTeam", { scope, teamId: newTeam.id })).team.draft
          .definition,
        newTeam.draft.definition,
      );
      record(
        "Team connection filters default to Reports to and reveal all retained permissions without editing the published template copy",
      );
      await click(memberNode(newTeam.draft.definition.members[0].id));
      await fill(
        selector('[aria-label="Member team role"]'),
        "Custom project lead",
      );
      await click(button("Save draft"));
      assert.deepEqual(
        (await rpc("getTeam", { scope, teamId: first.team.id })).team.draft
          .definition,
        firstBefore,
      );
      await capture("editable-template-copy");
      report.templates = { first: first.team.id, second: newTeam.id };
      record(
        "Actual template setup creates a second independently editable project team with fresh agent identities and leaves the prior copy intact",
      );
    } else {
      report.limitations.push(
        "Full template instantiation requires connected role models; only catalog/setup and editable bundled-agent copies are exercised in the no-provider profile. Use the provider harness --with-ui for actual template creation.",
      );
    }
    fixtureThread = await request("/threads", {
      projectId: saved.project.id,
      origin: "sdk",
      providerId: "codex",
      model: "gpt-6-astra",
      title: `UI recipients ${saved.token.slice(0, 8)}`,
      input: [
        { type: "text", text: "Deferred UI fixture; cancel before dispatch." },
      ],
      environment: {
        type: "host",
        hostId: daemon.hostId,
        workspace: { type: "unmanaged", path: saved.workspace },
      },
      sendAt: Date.now() + 86_400_000,
    });
    const queued = await request(
      `/threads/${fixtureThread.id}/queued-messages`,
    );
    assert.equal(queued.length, 1);
    await request(
      `/threads/${fixtureThread.id}/queued-messages/${queued[0].id}`,
      undefined,
      "DELETE",
    );
    assert.equal(
      (
        await request(
          `/threads/${fixtureThread.id}/events?types=turn%2Finput%2Faccepted&limit=1`,
        )
      ).length,
      0,
    );
    await startMentionDiagnostics();
    await navigate(`/projects/${saved.project.id}/threads/${fixtureThread.id}`);
    const composer = `[...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].find(e=>e.getBoundingClientRect().width>0)`;
    await until("thread composer", () => visible(composer));
    for (const label of [agents[1].name, name]) {
      await click(composer);
      await key("End", ["control"]);
      await type(` @${label.split(" ")[0]}`);
      const suggestion = `[...document.querySelectorAll('button')].find(e=>e.innerText.includes(${JSON.stringify(label)})&&e.innerText.includes('Send work')&&e.getBoundingClientRect().width>0)`;
      await until("published @ recipient suggestion", () =>
        visible(suggestion),
      );
      await click(suggestion);
      await until("persistent @ recipient chip", () =>
        visible(selector(`[aria-label="Remove ${label} recipient"]`)),
      );
    }
    await click(composer);
    await key("A", ["control"]);
    await key("Backspace");
    await type("This unsent draft keeps the selected team and reader.");
    assert.equal(
      await renderer(
        "document.querySelectorAll('[aria-label=\"Work recipients\"] button').length",
      ),
      2,
    );
    await navigate(`/projects/${saved.project.id}/threads/${fixtureThread.id}`);
    await until("persistent chips after reload", () =>
      renderer(
        "document.querySelectorAll('[aria-label=\"Work recipients\"] button').length===2",
      ),
    );
    assert.equal(
      (
        await request(
          `/threads/${fixtureThread.id}/events?types=turn%2Finput%2Faccepted&limit=1`,
        )
      ).length,
      0,
    );
    assert.equal(
      (await request(`/threads/${fixtureThread.id}/queued-messages`)).length,
      0,
    );
    await capture("persistent-agent-and-team-recipients");
    record(
      "Actual @ picker selects a published agent and team; both pinned recipients survive text deletion and renderer reload without starting a model",
    );
    await writeFile(
      requireWithin(root, join(root, "team-ui-fixture.json")),
      JSON.stringify(
        {
          teamId: fixture.id,
          threadId: fixtureThread.id,
          definition: published.draft.definition,
        },
        null,
        2,
      ),
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.stack : String(error);
    try {
      await stopMentionDiagnostics();
      report.visibleText = await renderer(
        "document.body.innerText.slice(0,30000)",
      );
      report.failureLayout = await layout();
      report.inputFailure = await renderer(
        "({focused:document.hasFocus(),events:window.__arcTeamUiInput??[]})",
      );
      await capture("failure");
    } catch (captureError) {
      report.captureError = String(captureError);
    }
    throw error;
  } finally {
    await stopMentionDiagnostics().catch(() => {});
    if (oldBounds)
      await native(
        `process.mainModule.require('electron').BrowserWindow.fromWebContents(c).setBounds(${JSON.stringify(oldBounds)});return true;`,
      ).catch(() => {});
    await writeFile(
      join(artifacts, "result.json"),
      JSON.stringify(report, null, 2),
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      executable: { type: "string" },
      "artifacts-parent": { type: "string" },
      "with-model-picker": { type: "boolean" },
      "codex-bin": { type: "string" },
      "codex-home": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    console.log(
      "Usage: node apps/desktop/scripts/smoke-arc-team-ui.mjs --executable <packaged ARC IDE.exe> [--artifacts-parent <directory>] [--with-model-picker] [--codex-bin <native codex.exe directory>] [--codex-home <existing authenticated Codex home>]\nExercises actual native Team/Workflow controls, palette drag, keyboard relationships/undo, guided skills and persistent @ recipients in owned isolated data. --with-model-picker also selects Astra using the real Codex catalogue, referencing existing provider authentication in place without copying or logging it. Does not dispatch providers. Full template creation is available through the provider harness --with-ui; duplicate live Send remains explicitly uncovered.",
    );
  else {
    assert(
      values["with-model-picker"] ||
        (!values["codex-bin"] && !values["codex-home"]),
      "--codex-bin and --codex-home require --with-model-picker",
    );
    let configureEnvironment;
    if (values["with-model-picker"]) {
      const nativeBin = resolve(
        values["codex-bin"] ??
          join(
            process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
            "npm",
            "node_modules",
            "@openai",
            "codex",
            "node_modules",
            "@openai",
            "codex-win32-x64",
            "vendor",
            "x86_64-pc-windows-msvc",
            "bin",
          ),
      );
      const codexHome = resolve(
        values["codex-home"] ??
          process.env.CODEX_HOME ??
          join(homedir(), ".codex"),
      );
      await access(join(nativeBin, "codex.exe"));
      configureEnvironment = (env) => ({
        ...env,
        CODEX_HOME: codexHome,
        PATH: [env.PATH, nativeBin].join(";"),
      });
    }
    await runSmoke(
      values.executable ??
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../release/win-unpacked/ARC IDE.exe",
        ),
      {
        artifactsParent: values["artifacts-parent"],
        configureEnvironment,
        verifyFeatures: (context) =>
          verifyTeamBuilderUi(context, {
            withModelPicker: values["with-model-picker"] ?? false,
          }),
      },
    ).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
