const {
  Plugin,
  ItemView,
  Notice,
  Modal,
  PluginSettingTab,
  Setting
} = require("obsidian");

const VIEW_TYPE = "relationship-graph-view";

/* ─────────────────────────────────────────────
   Utilities
───────────────────────────────────────────── */

function uid(prefix = "id") {
  return `${prefix}-${Math.random().toString(16).slice(2)}-${Date.now()}`;
}

function worldToScreen(x, y, cam, w, h) {
  return {
    x: (x - cam.x) * cam.zoom + w / 2,
    y: (y - cam.y) * cam.zoom + h / 2
  };
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    const ox = px - x1;
    const oy = py - y1;
    return Math.hypot(ox, oy);
  }

  const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));

  const cx = x1 + clamped * dx;
  const cy = y1 + clamped * dy;

  return Math.hypot(px - cx, py - cy);
}

/* ─────────────────────────────────────────────
   Plugin
───────────────────────────────────────────── */

module.exports = class RelationshipGraphPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};

    this.settings = {
      nodeFolder: data.nodeFolder || "GraphNodes"
    };

    this.edges = Array.isArray(data.edges) ? data.edges : [];

    this.registerView(
      VIEW_TYPE,
      leaf => new GraphView(leaf, this)
    );

    this.addCommand({
      id: "open-relationship-graph",
      name: "Open Relationship Graph",
      callback: () => this.openView()
    });

    this.addSettingTab(new GraphSettings(this.app, this));
  }

  async onunload() {}

  async openView() {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async savePluginData() {
    await this.saveData({
      nodeFolder: this.settings.nodeFolder,
      edges: this.edges
    });
  }

  async loadEdges() {
    const data = (await this.loadData()) || {};
    this.edges = Array.isArray(data.edges) ? data.edges : [];
  }

  async saveEdges() {
    await this.savePluginData();
  }
};

/* ─────────────────────────────────────────────
   View
───────────────────────────────────────────── */

class GraphView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;

    this.nodes = new Map(); // id → node
    this.selected = null;
    this.edgeFrom = null;
    this.selectedEdge = null;

    this.camera = { x: 0, y: 0, zoom: 1 };

    this.dragging = null; // { id, offsetX, offsetY, moved }
    this.panning = null;  // { startX, startY, camX, camY }
    this.mouseDown = false;
    this.dragThreshold = 5;
    this.lastMouse = null;

    this.resizeObserver = null;
    this._onWindowMouseUp = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Relationship Graph";
  }

  async onOpen() {
    this.contentEl.empty();

    /* top bar */
    const topBar = this.contentEl.createDiv({ cls: "graph-topbar" });
    const buttonBar = topBar.createDiv({ cls: "graph-buttons" });
    const help = this.contentEl.createDiv({ cls: "graph-help" });

    buttonBar.createEl("button", { text: "Refresh" }).onclick =
      () => this.loadNodes();

    buttonBar.createEl("button", { text: "New Edge" }).onclick = () => {
      if (!this.selected) {
        new Notice("Select a node first.");
        return;
      }
      this.edgeFrom = this.selected;
      new Notice("Click another node.");
    };

    help.createEl("strong", { text: "Controls" });
    help.createEl("br");
    help.appendText("• Left-click: Select");
    help.createEl("br");
    help.appendText("• Drag: Move node");
    help.createEl("br");
    help.appendText("• Double-click: Open note");
    help.createEl("br");
    help.appendText("• Right-click node: Start link");
    help.createEl("br");
    help.appendText("• Right-click edge: Menu (r = rename, d = delete)");
    help.createEl("br");
    help.appendText("• Right-click empty space: Create node");
    help.createEl("br");
    help.appendText("• Middle/right drag empty space: Pan");
    help.createEl("br");
    help.appendText("• Mouse wheel: Zoom");

    /* canvas */
    this.canvas = this.contentEl.createEl("canvas");
    this.ctx = this.canvas.getContext("2d");

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.contentEl);

    this._onWindowMouseUp = e => this.onMouseUp(e);
    window.addEventListener("mouseup", this._onWindowMouseUp);

    this.canvas.addEventListener("wheel", e => this.onWheel(e), { passive: false });
    this.canvas.addEventListener("mousedown", e => this.onMouseDown(e));
    this.canvas.addEventListener("mousemove", e => this.onMouseMove(e));
    this.canvas.addEventListener("mouseup", e => this.onMouseUp(e));
    this.canvas.addEventListener("contextmenu", e => this.onRightClick(e));
    this.canvas.addEventListener("dblclick", e => this.onDoubleClick(e));
    this.canvas.oncontextmenu = () => false;

    await this.plugin.loadEdges();
    await this.loadNodes();
    this.draw();
  }

  onClose() {
    if (this._onWindowMouseUp) {
      window.removeEventListener("mouseup", this._onWindowMouseUp);
      this._onWindowMouseUp = null;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  resize() {
    if (!this.canvas) return;
    const r = this.contentEl.getBoundingClientRect();
    this.canvas.width = r.width;
    this.canvas.height = r.height;
    this.draw();
  }

  screenToWorld(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;

    return {
      x: (sx - rect.width / 2) / this.camera.zoom + this.camera.x,
      y: (sy - rect.height / 2) / this.camera.zoom + this.camera.y
    };
  }

  hitNode(wx, wy) {
    for (const n of this.nodes.values()) {
      const dx = wx - n.x;
      const dy = wy - n.y;
      if (dx * dx + dy * dy < 22 * 22) return n;
    }
    return null;
  }

hitEdge(x, y) {
  
  for (const n of this.nodes.values()) {
    const dx = x - n.x;
    const dy = y - n.y;
    if (dx * dx + dy * dy < 28 * 28) {
      return null;
    }
  }

  const tolerance = 4 / this.camera.zoom; 

  for (const e of this.plugin.edges) {
    const a = this.nodes.get(e.from);
    const b = this.nodes.get(e.to);
    if (!a || !b) continue;

    const d = pointToSegmentDistance(
      x, y,
      a.x, a.y,
      b.x, b.y
    );

    if (d <= tolerance) return e;
  }

  return null;
}

  async onDoubleClick(ev) {
    ev.preventDefault();

    const { x, y } = this.screenToWorld(ev);
    const node = this.hitNode(x, y);
    if (!node) return;

    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!file) return;

    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  onWheel(ev) {
    ev.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;

    const wx = (sx - rect.width / 2) / this.camera.zoom + this.camera.x;
    const wy = (sy - rect.height / 2) / this.camera.zoom + this.camera.y;

    const zoomFactor = ev.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(4, Math.max(0.2, this.camera.zoom * zoomFactor));

    this.camera.zoom = newZoom;
    this.camera.x = wx - (sx - rect.width / 2) / newZoom;
    this.camera.y = wy - (sy - rect.height / 2) / newZoom;

    this.draw();
  }

  onMouseDown(ev) {
    const { x, y } = this.screenToWorld(ev);

    if ((ev.button === 1 || ev.button === 2) && !this.hitNode(x, y)) {
      this.panning = {
        startX: ev.clientX,
        startY: ev.clientY,
        camX: this.camera.x,
        camY: this.camera.y
      };
      this.mouseDown = true;
      return;
    }

    if (ev.button !== 0) return;

    const node = this.hitNode(x, y);

    this.mouseDown = true;
    this.lastMouse = { x, y };

    if (node) {
      this.dragging = {
        id: node.id,
        offsetX: x - node.x,
        offsetY: y - node.y,
        moved: false
      };
    }
  }

  onMouseMove(ev) {
    if (this.panning) {
      const dx = (ev.clientX - this.panning.startX) / this.camera.zoom;
      const dy = (ev.clientY - this.panning.startY) / this.camera.zoom;

      this.camera.x = this.panning.camX - dx;
      this.camera.y = this.panning.camY - dy;

      this.draw();
      return;
    }

    if (!this.mouseDown || !this.dragging) return;

    const { x, y } = this.screenToWorld(ev);

    const dx = x - this.lastMouse.x;
    const dy = y - this.lastMouse.y;

    if (!this.dragging.moved) {
      const dist = dx * dx + dy * dy;
      if (dist < this.dragThreshold * this.dragThreshold) return;
      this.dragging.moved = true;
    }

    const node = this.nodes.get(this.dragging.id);
    if (!node) return;

    node.x = x - this.dragging.offsetX;
    node.y = y - this.dragging.offsetY;

    this.lastMouse = { x, y };
    this.draw();
  }

async onMouseUp(ev) {
  if (this.panning) {
    this.panning = null;
    this.mouseDown = false;
    return;
  }

  if (!this.mouseDown) return;

  const wasDragging = this.dragging?.moved;
  const { x, y } = this.screenToWorld(ev);

  if (!wasDragging) {
    const node = this.hitNode(x, y);

    if (node) {
      if (this.edgeFrom && this.edgeFrom !== node.id) {
        await this.createEdge(this.edgeFrom, node.id);
        this.edgeFrom = null;
      } else {
        this.selected = node.id;
        this.selectedEdge = null;
      }
    } else {
      this.selected = null;
      this.selectedEdge = null;
    }
  } else {
    const node = this.nodes.get(this.dragging.id);
    if (node) await this.saveNodePosition(node);
  }

  this.dragging = null;
  this.mouseDown = false;
  this.lastMouse = null;

  this.draw();
}

async onRightClick(ev) {
  ev.preventDefault();

  const { x, y } = this.screenToWorld(ev);

  const node = this.hitNode(x, y);
  if (node) {
    this.selected = node.id;
    this.selectedEdge = null;
    this.draw();

    if (!this.edgeFrom) {
      this.edgeFrom = node.id;
      new Notice("Click another node to create a relationship.");
    }

    return;
  }

  const edge = this.hitEdge(x, y);
  if (edge) {
    this.selectedEdge = edge.id;
    this.selected = null;
    this.draw();
    await this.edgeContextMenu(edge);
    return;
  }

  await this.createNodeAt(x, y);
}

  async renameEdge(edge) {
    const modal = new TextModal(this.app, "Rename relationship");
    modal.value = edge.label;
    const name = await modal.get();
    if (!name) return;

    edge.label = name;
    await this.plugin.saveEdges();
    this.draw();
  }

  async deleteEdge(edge) {
    this.plugin.edges = this.plugin.edges.filter(e => e.id !== edge.id);
    this.selectedEdge = null;
    await this.plugin.saveEdges();
    this.draw();
  }

  async edgeContextMenu(edge) {
    const modal = new TextModal(this.app, "Edge action (rename / delete)");
    const action = await modal.get();
    if (!action) return;

    const a = action.toLowerCase();
    if (a.startsWith("r")) {
      await this.renameEdge(edge);
    } else if (a.startsWith("d")) {
      await this.deleteEdge(edge);
    }
  }

  async createNodeAt(x, y) {
    const modal = new TextModal(this.app, "New node name");
    const name = await modal.get();
    if (!name) return;

    const folder = this.plugin.settings.nodeFolder;

    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    const safe = name.replace(/[\\\/:*?"<>|]/g, "-");
    const path = `${folder}/${safe}.md`;

    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice("Note already exists.");
      return;
    }

    const id = uid("node");

    const content =
`---
graph:
  id: ${id}
  x: ${Math.round(x)}
  y: ${Math.round(y)}
---

`;

    await this.app.vault.create(path, content);

    await this.loadNodes();
    this.selected = id;
    this.selectedEdge = null;
    this.draw();
  }

  async saveNodePosition(node) {
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!file) return;

    await this.app.fileManager.processFrontMatter(file, fm => {
      fm.graph ??= {};
      fm.graph.x = Math.round(node.x);
      fm.graph.y = Math.round(node.y);
    });
  }

  async loadNodes() {
    this.nodes.clear();

    const folder = this.plugin.settings.nodeFolder;
    const files = this.app.vault.getMarkdownFiles()
      .filter(f => f.path.startsWith(folder + "/"));

    for (const file of files) {
      const id = await this.ensureId(file);
      const cache = this.app.metadataCache.getFileCache(file);
      const g = cache?.frontmatter?.graph || {};

      this.nodes.set(id, {
        id,
        label: file.basename,
        path: file.path,
        x: typeof g.x === "number" ? g.x : Math.random() * 600 - 300,
        y: typeof g.y === "number" ? g.y : Math.random() * 400 - 200
      });
    }

    this.draw();
  }

  async ensureId(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter?.graph;

    if (fm?.id) return fm.id;

    const id = uid("node");
    await this.app.fileManager.processFrontMatter(file, frontmatter => {
      frontmatter.graph ??= {};
      frontmatter.graph.id = id;
    });
    return id;
  }

  async createEdge(from, to) {
    const modal = new TextModal(this.app, "Relationship");
    const label = await modal.get();
    if (!label) return;

    this.plugin.edges.push({
      id: uid("edge"),
      from,
      to,
      label
    });

    await this.plugin.saveEdges();
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;

    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    ctx.font = "13px system-ui, sans-serif";
    ctx.textBaseline = "middle";

    /* edges */
    for (const e of this.plugin.edges) {
      const a = this.nodes.get(e.from);
      const b = this.nodes.get(e.to);
      if (!a || !b) continue;

      const p1 = worldToScreen(a.x, a.y, this.camera, w, h);
      const p2 = worldToScreen(b.x, b.y, this.camera, w, h);

      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;

      const isSelected = e.id === this.selectedEdge;

      ctx.strokeStyle = isSelected ? "#facc15" : "#666";
      ctx.lineWidth = isSelected ? 4 : 1.5;

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      ctx.fillStyle = isSelected ? "#fde68a" : "#aaa";
      ctx.textAlign = "left";
      ctx.fillText(e.label, mx + 6, my - 6);
    }

    /* nodes */
    for (const n of this.nodes.values()) {
      const p = worldToScreen(n.x, n.y, this.camera, w, h);

      const baseRadius = 22;
      const radius = Math.max(
        6,
        baseRadius * Math.pow(this.camera.zoom, 0.6)
      );

      const isSelected = n.id === this.selected;

      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = "rgba(147,197,253,0.7)";
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();

      ctx.fillStyle = isSelected ? "#3b82f6" : "#800000";
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(n.label, p.x, p.y);

      ctx.restore();
    }
  }
}

/* ─────────────────────────────────────────────
   Modal
───────────────────────────────────────────── */

class TextModal extends Modal {
  constructor(app, label) {
    super(app);
    this.label = label;
    this.value = null;
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: this.label });

    this.input = this.contentEl.createEl("input", { type: "text" });
    if (typeof this.value === "string") {
      this.input.value = this.value;
    }

    this.input.focus();
    this.input.select();

    const buttonRow = this.contentEl.createDiv();

    const ok = buttonRow.createEl("button", { text: "OK" });
    ok.onclick = () => {
      this.value = this.input.value.trim();
      this.close();
    };

    this.input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        this.value = this.input.value.trim();
        this.close();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
    this.resolve?.(this.value);
  }

  get() {
    this.open();
    return new Promise(res => {
      this.resolve = res;
    });
  }
}

/* ─────────────────────────────────────────────
   Settings
───────────────────────────────────────────── */

class GraphSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();

    new Setting(this.containerEl)
      .setName("Node folder")
      .addText(t =>
        t.setValue(this.plugin.settings.nodeFolder)
          .onChange(async v => {
            this.plugin.settings.nodeFolder = v.trim() || "GraphNodes";
            await this.plugin.savePluginData();
          })
      );
  }
}