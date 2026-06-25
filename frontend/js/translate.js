/**
 * 文件翻译页面 — 左右对照、点击联动、数据库持久化
 */

const TranslateApp = {
    blocks: [],
    sourceLang: 'auto',
    targetLang: '中文',
    isTranslating: false,
    isDone: false,
    recordId: '',
    currentFileName: '',

    async init() {
        try {
            const auth = await API.checkAuth();
            if (!auth.authenticated) { location.href = '/'; return; }
        } catch { location.href = '/'; return; }
        this.bindUpload();
        this.bindLangSelect();
        this.bindTranslate();
        this.bindExport();
        this.bindDivider();
        this.bindBlockClicks();
        this.bindHistory();
        await this.restoreLatest();
    },

    bindUpload() {
        const zone = document.getElementById('upload-zone');
        const input = document.getElementById('file-input');
        zone.addEventListener('click', () => input.click());
        input.addEventListener('change', () => { const f = input.files?.[0]; if (f) this.handleFile(f); });
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => { zone.classList.remove('dragover'); });
        zone.addEventListener('drop', (e) => {
            e.preventDefault(); zone.classList.remove('dragover');
            const f = e.dataTransfer?.files?.[0]; if (f) this.handleFile(f);
        });
    },

    async handleFile(file) {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        if (!['.pdf', '.docx', '.doc', '.txt', '.md'].includes(ext)) { alert('不支持的文件格式'); return; }
        if (file.size > 50 * 1024 * 1024) { alert('文件过大，最大支持 50MB'); return; }
        const base64 = await this.fileToBase64(file);
        const fileData = base64.split(',')[1] || base64;
        this.currentFileName = file.name;
        document.getElementById('file-name-display').textContent = file.name;
        document.getElementById('file-info').classList.remove('hidden');
        document.getElementById('progress-area').classList.remove('hidden');
        document.getElementById('progress-fill').style.width = '0%';
        document.getElementById('progress-text').textContent = '解析中...';
        try {
            const resp = await fetch('/api/translate/upload', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                body: JSON.stringify({ file_data: fileData, file_name: file.name, source_lang: this.sourceLang, target_lang: this.targetLang }),
            });
            if (!resp.ok) { const e = await resp.json().catch(() => ({ detail: '解析失败' })); throw new Error(e.detail || '解析失败'); }
            const data = await resp.json();
            this.blocks = data.blocks; this.sourceLang = data.source_lang; this.targetLang = data.target_lang;
            this.recordId = this._makeRecordId(file.name);
            document.getElementById('source-lang-label').textContent = data.source_lang === 'auto' ? '自动检测' : data.source_lang;
            document.getElementById('target-lang-label').textContent = data.target_lang;
            this.renderSource(); this.renderTarget();
            document.getElementById('block-count').textContent = `共 ${data.total_blocks} 段`;
            document.getElementById('progress-text').textContent = `就绪，共 ${data.total_blocks} 段`;
            document.getElementById('translate-btn').disabled = false;
            document.getElementById('progress-area').classList.add('hidden');
            this.isDone = false;
            document.getElementById('export-area').classList.add('hidden');
            await this._saveToDb();
        } catch (e) { alert('解析失败: ' + e.message); document.getElementById('progress-area').classList.add('hidden'); }
    },

    fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file);
        });
    },

    _makeRecordId(filename) {
        return filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Date.now().toString(36);
    },

    async _saveToDb() {
        if (!this.recordId || !this.blocks.length) return;
        try { await fetch('/api/translate/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: this.recordId, filename: this.currentFileName, source_lang: this.sourceLang, target_lang: this.targetLang, blocks: this.blocks }) }); }
        catch (e) { console.warn('保存失败:', e); }
    },

    async restoreLatest() {
        try {
            const resp = await fetch('/api/translate/history', { credentials: 'include' });
            if (!resp.ok) return;
            const records = (await resp.json()).records || [];
            if (!records.length) return;
            const detail = await (await fetch(`/api/translate/history/${encodeURIComponent(records[0].id)}`, { credentials: 'include' })).json();
            if (!detail.blocks || !detail.blocks.length) return;
            this.recordId = detail.id; this.blocks = detail.blocks; this.sourceLang = detail.source_lang; this.targetLang = detail.target_lang; this.currentFileName = detail.filename;
            document.getElementById('file-name-display').textContent = detail.filename;
            document.getElementById('file-info').classList.remove('hidden');
            document.getElementById('block-count').textContent = `共 ${detail.total_blocks} 段`;
            document.getElementById('source-lang-label').textContent = detail.source_lang === 'auto' ? '自动检测' : detail.source_lang;
            document.getElementById('target-lang-label').textContent = detail.target_lang;
            this.renderSource(); this.renderTarget();
            document.getElementById('translate-btn').disabled = false;
            const t = detail.translated_blocks || 0, n = detail.total_blocks || 1;
            if (t > 0) {
                this.isDone = t >= n;
                document.getElementById('progress-fill').style.width = Math.round((t / n) * 100) + '%';
                document.getElementById('progress-text').textContent = this.isDone ? '翻译完成 ' + t + '/' + n + ' 段' : '已翻译 ' + t + '/' + n + ' 段';
                if (this.isDone) document.getElementById('export-area').classList.remove('hidden');
            }
        } catch (e) { console.warn('恢复失败:', e); }
    },

    bindHistory() {
        document.getElementById('history-btn').addEventListener('click', () => this.showHistoryList());
    },

    async showHistoryList() {
        try {
            const resp = await fetch('/api/translate/history', { credentials: 'include' });
            if (!resp.ok) return;
            const records = (await resp.json()).records || [];
            const list = document.getElementById('history-list');
            const modal = document.getElementById('history-modal');
            if (!records.length) { list.innerHTML = '<div class="history-empty">暂无历史记录</div>'; }
            else {
                list.innerHTML = records.map(function(r) {
                    var pct = r.total_blocks > 0 ? Math.round(r.translated_blocks / r.total_blocks * 100) : 0;
                    var active = r.id === TranslateApp.recordId ? 'history-item-active' : '';
                    return '<div class="history-item ' + active + '" data-id="' + r.id + '"><div><div class="history-item-name">' + TranslateApp.escapeHtml(r.filename) + '</div><div class="history-item-meta">' + r.source_lang + ' → ' + r.target_lang + ' · ' + r.translated_blocks + '/' + r.total_blocks + ' 段 (' + pct + '%)</div></div><button class="history-delete-btn" data-id="' + r.id + '">删除</button></div>';
                }).join('');
                list.querySelectorAll('.history-item').forEach(function(el) {
                    el.addEventListener('click', function(e) { if (e.target.closest('.history-delete-btn')) return; TranslateApp.loadHistoryRecord(el.dataset.id); modal.classList.add('hidden'); });
                });
                list.querySelectorAll('.history-delete-btn').forEach(function(btn) {
                    btn.addEventListener('click', async function(e) {
                        e.stopPropagation();
                        if (!confirm('确定删除？')) return;
                        await TranslateApp.deleteHistoryRecord(btn.dataset.id);
                        btn.closest('.history-item').remove();
                        if (btn.dataset.id === TranslateApp.recordId) {
                            TranslateApp.blocks = []; TranslateApp.recordId = ''; TranslateApp.isDone = false;
                            document.getElementById('source-content').innerHTML = '<div class="empty-panel">上传文件后这里将显示原文</div>';
                            document.getElementById('target-content').innerHTML = '<div class="empty-panel">翻译完成后这里将显示译文</div>';
                            document.getElementById('translate-btn').disabled = true;
                            document.getElementById('export-area').classList.add('hidden');
                            document.getElementById('progress-area').classList.add('hidden');
                            document.getElementById('file-info').classList.add('hidden');
                        }
                    });
                });
            }
            modal.classList.remove('hidden');
            modal.addEventListener('click', function(e) { if (e.target === modal) modal.classList.add('hidden'); });
        } catch (e) { alert('加载历史记录失败: ' + e.message); }
    },

    async loadHistoryRecord(recordId) {
        try {
            var detail = await (await fetch('/api/translate/history/' + encodeURIComponent(recordId), { credentials: 'include' })).json();
            if (!detail.blocks || !detail.blocks.length) return;
            this.recordId = detail.id; this.blocks = detail.blocks; this.sourceLang = detail.source_lang; this.targetLang = detail.target_lang; this.currentFileName = detail.filename;
            document.getElementById('file-name-display').textContent = detail.filename;
            document.getElementById('file-info').classList.remove('hidden');
            document.getElementById('block-count').textContent = '共 ' + detail.total_blocks + ' 段';
            document.getElementById('source-lang-label').textContent = detail.source_lang === 'auto' ? '自动检测' : detail.source_lang;
            document.getElementById('target-lang-label').textContent = detail.target_lang;
            this.renderSource(); this.renderTarget();
            document.getElementById('translate-btn').disabled = false;
            var t = detail.translated_blocks || 0, n = detail.total_blocks || 1;
            this.isDone = t >= n;
            if (t > 0) {
                document.getElementById('progress-fill').style.width = Math.round(t / n * 100) + '%';
                document.getElementById('progress-text').textContent = this.isDone ? '翻译完成 ' + t + '/' + n + ' 段' : '已翻译 ' + t + '/' + n + ' 段';
            }
            if (this.isDone) document.getElementById('export-area').classList.remove('hidden');
            else document.getElementById('export-area').classList.add('hidden');
        } catch (e) { alert('加载失败: ' + e.message); }
    },

    async deleteHistoryRecord(recordId) {
        try { await fetch('/api/translate/history/' + encodeURIComponent(recordId), { method: 'DELETE', credentials: 'include' }); }
        catch (e) { console.warn('删除失败:', e); }
    },

    bindLangSelect() {
        document.getElementById('source-lang').addEventListener('change', function(e) { TranslateApp.sourceLang = e.target.value; });
        document.getElementById('target-lang').addEventListener('change', function(e) { TranslateApp.targetLang = e.target.value; });
    },

    bindTranslate() {
        document.getElementById('translate-btn').addEventListener('click', function() { TranslateApp.startTranslation(); });
    },

    async startTranslation() {
        if (this.isTranslating || !this.blocks.length) return;
        this.blocks.forEach(function(b) { b.translation = ''; });
        this.isTranslating = true; this.isDone = false;
        var btn = document.getElementById('translate-btn');
        btn.disabled = true; btn.textContent = '翻译中...';
        document.getElementById('progress-area').classList.remove('hidden');
        document.getElementById('export-area').classList.add('hidden');
        document.getElementById('target-content').innerHTML = '<div class="empty-panel">翻译中...</div>';
        try { if (this.blocks.length <= 50) await this.translateSync(); else await this.translateAsync(); }
        catch (e) { alert('翻译失败: ' + e.message); }
        this.isTranslating = false; btn.disabled = false; btn.textContent = '开始翻译';
        if (this.isDone) document.getElementById('export-area').classList.remove('hidden');
    },

    async translateSync() {
        var resp = await fetch('/api/translate/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ blocks: this.blocks, source_lang: this.sourceLang, target_lang: this.targetLang }),
        });
        if (!resp.ok) { var e = await resp.json().catch(function() { return { detail: '翻译失败' }; }); throw new Error(e.detail || '翻译失败'); }
        var data = await resp.json();
        this.blocks = data.blocks; this.renderTarget();
        document.getElementById('progress-fill').style.width = '100%';
        document.getElementById('progress-text').textContent = '翻译完成 ' + data.total + '/' + data.total + ' 段';
        this.isDone = true; await this._saveToDb();
    },

    async translateAsync() {
        var startResp = await fetch('/api/translate/start-async', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ blocks: this.blocks, source_lang: this.sourceLang, target_lang: this.targetLang, file_name: document.getElementById('file-name-display').textContent || 'document' }),
        });
        if (!startResp.ok) { var e = await startResp.json().catch(function() { return { detail: '启动失败' }; }); throw new Error(e.detail || '启动失败'); }
        var job_id = (await startResp.json()).job_id, done = false;
        while (!done) {
            await new Promise(function(r) { setTimeout(r, 1500); });
            var status = await (await fetch('/api/translate/status/' + job_id, { credentials: 'include' })).json();
            var completed = status.completed || 0, total = status.total || 1;
            document.getElementById('progress-fill').style.width = Math.round(completed / total * 100) + '%';
            document.getElementById('progress-text').textContent = '翻译中 ' + completed + '/' + total + ' 段';
            if (status.blocks && status.blocks.length > 0) { this.blocks = status.blocks; this.renderTarget(); }
            if (status.status === 'done') { done = true; this.isDone = true; document.getElementById('progress-fill').style.width = '100%'; document.getElementById('progress-text').textContent = '翻译完成 ' + total + '/' + total + ' 段'; if (status.blocks) { this.blocks = status.blocks; this.renderTarget(); } await this._saveToDb(); }
            else if (status.status === 'failed') { throw new Error(status.error || '翻译失败'); }
        }
    },

    renderSource() {
        var c = document.getElementById('source-content');
        if (!this.blocks.length) { c.innerHTML = '<div class="empty-panel">上传文件后这里将显示原文</div>'; return; }
        c.innerHTML = this.blocks.map(function(b) { return '<div class="block-item" data-block-id="' + b.id + '" data-panel="source">' + TranslateApp.renderBlockContent(b, 'original') + '</div>'; }).join('');
    },

    renderTarget() {
        var c = document.getElementById('target-content');
        var hasAny = this.blocks.some(function(b) { return b.translation && b.translation.trim(); });
        if (!hasAny) { c.innerHTML = '<div class="empty-panel">翻译中...</div>'; return; }
        c.innerHTML = this.blocks.map(function(b, i) {
            var ok = b.translation && b.translation.trim();
            var html = ok ? TranslateApp.renderBlockContent(b, 'translation') : '<p style="color:var(--text-muted);font-style:italic;">翻译中...</p>';
            return '<div class="block-item ' + (ok ? 'translated' : 'translating') + '" data-block-id="' + b.id + '" data-panel="target" style="animation-delay:' + (i * 0.03) + 's">' + html + '</div>';
        }).join('');
    },

    renderBlockContent: function(block, field) {
        var text = block[field] || '';
        if (!text) return '';
        try { return marked.parse(text, { breaks: true, gfm: true }); }
        catch (e) { return '<p>' + TranslateApp.escapeHtml(text) + '</p>'; }
    },

    escapeHtml: function(str) {
        var d = document.createElement('div'); d.textContent = str; return d.innerHTML;
    },

    bindBlockClicks() {
        document.getElementById('translate-view').addEventListener('click', function(e) {
            var el = e.target.closest('.block-item');
            if (!el) return;
            var id = el.dataset.blockId, panel = el.dataset.panel;
            var targetId = panel === 'source' ? 'target-content' : 'source-content';
            var tp = document.getElementById(targetId);
            var te = tp ? tp.querySelector('.block-item[data-block-id="' + id + '"]') : null;
            if (te) {
                te.classList.remove('highlight-fade'); te.classList.add('highlighted');
                tp.scrollTo({ top: te.offsetTop - 60, behavior: 'smooth' });
                setTimeout(function() { te.classList.remove('highlighted'); te.classList.add('highlight-fade'); }, 2000);
            }
            el.classList.remove('highlight-fade'); el.classList.add('highlighted');
            setTimeout(function() { el.classList.remove('highlighted'); el.classList.add('highlight-fade'); }, 1500);
        });
    },

    bindDivider() {
        var divider = document.getElementById('translate-divider');
        var sp = document.getElementById('source-panel'), tp = document.getElementById('target-panel'), v = document.getElementById('translate-view');
        var drag = false;
        divider.addEventListener('mousedown', function() { drag = true; divider.classList.add('active'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
        document.addEventListener('mousemove', function(e) {
            if (!drag) return;
            var pct = Math.max(20, Math.min(80, (e.clientX - v.getBoundingClientRect().left) / v.offsetWidth * 100));
            sp.style.flex = '0 0 ' + pct + '%'; tp.style.flex = '0 0 ' + (100 - pct) + '%';
        });
        document.addEventListener('mouseup', function() { if (drag) { drag = false; divider.classList.remove('active'); document.body.style.cursor = ''; document.body.style.userSelect = ''; } });
    },

    bindExport() {
        document.getElementById('export-docx-btn').addEventListener('click', function() { TranslateApp.exportFormat('docx', '译文.docx'); });
        document.getElementById('export-txt-btn').addEventListener('click', function() { TranslateApp.exportFormat('txt', '译文.txt'); });
    },

    async exportFormat(format, filename) {
        if (!this.blocks.length) return;
        var title = (document.getElementById('file-name-display').textContent || '译文').replace(/\.[^.]+$/, '') + '_译文';
        try {
            var res = await fetch('/api/translate/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ blocks: this.blocks, format: format, title: title }) });
            if (!res.ok) { var e = await res.json().catch(function() { return { detail: '导出失败' }; }); throw new Error(e.detail || '导出失败'); }
            var blob = await res.blob(), url = URL.createObjectURL(blob);
            var a = document.createElement('a'); a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) { alert('导出失败: ' + e.message); }
    },

    setStatus: function(msg) { document.getElementById('progress-text').textContent = msg; },
};

document.addEventListener('DOMContentLoaded', function() { TranslateApp.init(); });
