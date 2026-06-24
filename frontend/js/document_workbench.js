const DocumentWorkbench = {
    currentContent: '',
    currentTitle: '法律文书',
    selectedFiles: [],
    docTypes: {
        complaint: {
            name: '起诉状',
            required: ['管辖法院', '原告信息', '被告信息', '诉讼请求', '事实与理由'],
            fields: [
                ['管辖法院', 'input', '例如：北京市朝阳区人民法院'],
                ['原告信息', 'textarea', '姓名/名称、身份证号或统一社会信用代码、住所、联系方式'],
                ['被告信息', 'textarea', '姓名/名称、身份证号或统一社会信用代码、住所、联系方式'],
                ['案由', 'input', '例如：民间借贷纠纷'],
                ['诉讼请求', 'textarea', '逐条写明请求，例如本金、利息、违约金、费用承担'],
                ['事实与理由', 'textarea', '按时间顺序描述事实经过'],
                ['证据清单', 'textarea', '证据名称、来源、证明目的'],
            ],
        },
        defense: {
            name: '答辩状',
            required: ['答辩人信息', '被答辩人信息', '案由', '答辩意见', '事实与理由'],
            fields: [
                ['答辩人信息', 'textarea', '姓名/名称、身份信息、地址、联系方式'],
                ['被答辩人信息', 'textarea', '对方当事人基本信息'],
                ['案由', 'input', '例如：买卖合同纠纷'],
                ['对方主要诉请', 'textarea', '概括原告/申请人的请求'],
                ['答辩意见', 'textarea', '逐条写明不同意或部分同意的理由'],
                ['事实与理由', 'textarea', '补充己方事实、抗辩理由和法律依据'],
                ['证据清单', 'textarea', '证据名称、来源、证明目的'],
            ],
        },
        lawyer_letter: {
            name: '律师函',
            required: ['委托人', '收函方名称', '委托事项', '事实背景', '具体要求'],
            fields: [
                ['委托人', 'input', '委托人姓名或公司名称'],
                ['收函方名称', 'input', '对方姓名或公司名称'],
                ['委托事项', 'textarea', '例如：催告还款、停止侵权、解除合同'],
                ['事实背景', 'textarea', '争议经过、关键日期、金额、沟通情况'],
                ['法律依据', 'textarea', '已知依据可填写，不清楚可留空'],
                ['具体要求', 'textarea', '要求对方完成的事项和期限'],
            ],
        },
        legal_opinion: {
            name: '法律意见书',
            required: ['委托人', '委托事项', '背景情况', '法律分析要点', '期望结论'],
            fields: [
                ['委托人', 'input', '委托人姓名或公司名称'],
                ['委托事项', 'textarea', '需要分析的问题'],
                ['背景情况', 'textarea', '事实背景、交易结构、争议焦点'],
                ['法律分析要点', 'textarea', '希望重点分析的法律问题'],
                ['期望结论', 'textarea', '希望判断合法性、风险、可行方案等'],
            ],
        },
        contract: {
            name: '合同/协议',
            required: ['合同类型', '甲方信息', '乙方信息', '核心条款'],
            fields: [
                ['合同类型', 'input', '例如：服务合同、借款协议、和解协议'],
                ['甲方信息', 'textarea', '姓名/名称、证件号、地址、联系方式'],
                ['乙方信息', 'textarea', '姓名/名称、证件号、地址、联系方式'],
                ['核心条款', 'textarea', '标的、金额、履行期限、交付方式、付款安排'],
                ['违约责任', 'textarea', '逾期、解除、赔偿、争议解决等'],
                ['特别约定', 'textarea', '保密、知识产权、担保、管辖等'],
            ],
        },
    },

    async init() {
        const auth = await API.checkAuth().catch(() => ({ authenticated: false }));
        if (!auth.authenticated) {
            document.getElementById('document-auth-page').classList.remove('hidden');
            return;
        }
        this.user = auth.user || null;
        this.applyTheme();
        document.getElementById('document-page').classList.remove('hidden');
        this.bind();
        this.renderDocTypes();
        this.applyInitialType();
        this.renderFields();
        this.updateExtractButton();
    },

    bind() {
        document.getElementById('doc-type-select').addEventListener('change', () => this.renderFields());
        document.getElementById('doc-extract-btn').addEventListener('click', () => this.extractInfoFromFiles());
        document.getElementById('doc-check-btn').addEventListener('click', () => this.checkMissing());
        document.getElementById('doc-generate-workbench-btn').addEventListener('click', () => this.generate());
        document.getElementById('doc-clear-btn').addEventListener('click', () => this.clearFields());
        document.getElementById('doc-copy-btn').addEventListener('click', () => this.copyContent());
        document.getElementById('doc-download-btn').addEventListener('click', () => this.downloadWord());
        document.getElementById('document-upload-zone').addEventListener('click', () => {
            document.getElementById('document-file-input').click();
        });
        document.getElementById('document-file-input').addEventListener('change', e => {
            Array.from(e.target.files || []).forEach(file => this.addFile(file));
            e.target.value = '';
        });
        document.getElementById('document-upload-zone').addEventListener('dragover', e => {
            e.preventDefault();
            e.currentTarget.classList.add('dragging');
        });
        document.getElementById('document-upload-zone').addEventListener('dragleave', e => {
            e.currentTarget.classList.remove('dragging');
        });
        document.getElementById('document-upload-zone').addEventListener('drop', e => {
            e.preventDefault();
            e.currentTarget.classList.remove('dragging');
            Array.from(e.dataTransfer?.files || []).forEach(file => this.addFile(file));
        });
        document.getElementById('document-logout-btn').addEventListener('click', async () => {
            await API.logout().catch(() => {});
            window.location.href = '/';
        });
    },

    addFile(file) {
        const maxSize = 30 * 1024 * 1024;
        if (file.size > maxSize) {
            alert(`文件「${file.name}」超过 30MB，建议压缩后上传`);
            return;
        }
        const duplicate = this.selectedFiles.some(item => item.name === file.name && item.size === file.size);
        if (duplicate) return;
        this.selectedFiles.push(file);
        this.renderFiles();
    },

    removeFile(index) {
        this.selectedFiles.splice(index, 1);
        this.renderFiles();
    },

    renderFiles() {
        const list = document.getElementById('document-file-list');
        if (!this.selectedFiles.length) {
            list.classList.add('hidden');
            list.innerHTML = '';
            this.updateExtractButton();
            return;
        }
        list.classList.remove('hidden');
        list.innerHTML = this.selectedFiles.map((file, index) => `
            <span class="document-file-chip">
                <span title="${this.escape(file.name)}">${this.fileIcon(file.name)} ${this.escape(file.name)}</span>
                <button type="button" data-file-index="${index}" title="移除">×</button>
            </span>
        `).join('');
        list.querySelectorAll('[data-file-index]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                this.removeFile(Number(btn.dataset.fileIndex));
            });
        });
        this.updateExtractButton();
    },

    updateExtractButton() {
        const btn = document.getElementById('doc-extract-btn');
        if (btn) btn.disabled = this.selectedFiles.length === 0;
    },

    fileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        const map = { pdf: 'PDF', doc: 'DOC', docx: 'DOC', txt: 'TXT', md: 'TXT', png: 'IMG', jpg: 'IMG', jpeg: 'IMG', bmp: 'IMG' };
        return map[ext] || 'FILE';
    },

    async readFilesAsBase64() {
        const files = [];
        for (const file of this.selectedFiles) {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            files.push({
                name: file.name,
                mime_type: dataUrl.substring(5, dataUrl.indexOf(';')),
                data: dataUrl.substring(dataUrl.indexOf(',') + 1),
            });
        }
        return files;
    },

    renderDocTypes() {
        const select = document.getElementById('doc-type-select');
        select.innerHTML = Object.entries(this.docTypes)
            .map(([key, item]) => `<option value="${key}">${this.escape(item.name)}</option>`)
            .join('');
    },

    applyInitialType() {
        const type = new URLSearchParams(window.location.search).get('type');
        if (type && this.docTypes[type]) {
            document.getElementById('doc-type-select').value = type;
        }
    },

    renderFields() {
        const docType = document.getElementById('doc-type-select').value || 'complaint';
        const config = this.docTypes[docType];
        document.getElementById('doc-form-title').textContent = `${config.name}信息`;
        document.getElementById('doc-preview-title').textContent = `${config.name}预览`;
        document.getElementById('doc-dynamic-fields').innerHTML = config.fields.map(([name, type, placeholder]) => `
            <label class="document-field ${type === 'textarea' ? 'full' : ''}">
                <span>${this.escape(name)}</span>
                ${type === 'textarea'
                    ? `<textarea data-field="${this.escape(name)}" placeholder="${this.escape(placeholder)}"></textarea>`
                    : `<input data-field="${this.escape(name)}" placeholder="${this.escape(placeholder)}">`}
            </label>
        `).join('');
        this.hideMissing();
    },

    collectInfo() {
        const info = {};
        document.querySelectorAll('[data-field]').forEach(el => {
            info[el.dataset.field] = el.value.trim();
        });
        const caseType = document.getElementById('case-type-select').value;
        const writingMode = document.getElementById('writing-mode-select').value;
        const includeLaw = document.getElementById('include-law-input').checked;
        const includeEvidence = document.getElementById('include-evidence-input').checked;
        const extra = document.getElementById('doc-extra-input').value.trim();
        info['案件类型'] = caseType;
        info['写作目标'] = writingMode;
        info['生成要求'] = [
            includeLaw ? '请列明相关法律依据' : '法律依据可简要处理',
            includeEvidence ? '请同步整理证据目录或证明目的' : '无需单独整理证据目录',
            extra,
        ].filter(Boolean).join('；');
        return info;
    },

    currentFieldNames() {
        const docType = document.getElementById('doc-type-select').value || 'complaint';
        return (this.docTypes[docType]?.fields || []).map(([name]) => name);
    },

    fillExtractedInfo(extracted) {
        if (!extracted || typeof extracted !== 'object') return 0;
        let count = 0;
        document.querySelectorAll('[data-field]').forEach(el => {
            const value = extracted[el.dataset.field];
            if (value === undefined || value === null) return;
            const text = Array.isArray(value) ? value.join('\n') : String(value).trim();
            if (!text) return;
            el.value = text;
            count += 1;
        });
        return count;
    },

    async extractInfoFromFiles() {
        if (!this.selectedFiles.length) {
            alert('请先上传案件资料');
            return;
        }
        const docType = document.getElementById('doc-type-select').value;
        const btn = document.getElementById('doc-extract-btn');
        btn.disabled = true;
        this.setStatus('正在读取资料并提取结构化信息...');
        try {
            const files = await this.readFilesAsBase64();
            const result = await API.extractDocumentInfo(
                docType,
                this.currentFieldNames(),
                files,
                this.collectInfo()
            );
            const filled = this.fillExtractedInfo(result.info || {});
            this.checkMissing();
            this.showExtractionNotes(result, filled);
            this.setStatus(`已提取 ${filled} 个字段，可继续修改后生成文书`);
        } catch (e) {
            this.setStatus(`提取失败：${e.message}`);
        } finally {
            btn.disabled = false;
        }
    },

    showExtractionNotes(result, filled) {
        const box = document.getElementById('doc-missing-list');
        const notes = Array.isArray(result?.notes) ? result.notes.filter(Boolean) : [];
        const sources = Array.isArray(result?.sources) ? result.sources.filter(Boolean) : [];
        box.classList.remove('hidden');
        box.innerHTML = `
            <strong>资料提取结果</strong>
            <p>已自动填入 ${filled} 个字段，请核对后再生成正式文书。</p>
            ${notes.length ? `<p>提示：${notes.map(item => this.escape(item)).join('；')}</p>` : ''}
            ${sources.length ? `<p>已读取：${sources.map(item => this.escape(item)).join('、')}</p>` : ''}
        `;
    },

    checkMissing() {
        const docType = document.getElementById('doc-type-select').value;
        const config = this.docTypes[docType];
        const info = this.collectInfo();
        const missing = config.required.filter(field => !info[field]);
        const weak = Object.entries(info)
            .filter(([key, value]) => value && value.length < 8 && !['案件类型', '写作目标'].includes(key))
            .map(([key]) => key);
        const box = document.getElementById('doc-missing-list');
        box.classList.remove('hidden');
        if (!missing.length && !weak.length) {
            box.innerHTML = '<strong>信息检查</strong><p>核心信息已经比较完整，可以生成初稿。</p>';
            return true;
        }
        box.innerHTML = `
            <strong>信息检查</strong>
            ${missing.length ? `<p>建议补充：${missing.map(item => `【${this.escape(item)}】`).join('、')}</p>` : ''}
            ${weak.length ? `<p>可能过短：${weak.map(item => `【${this.escape(item)}】`).join('、')}</p>` : ''}
        `;
        return false;
    },

    async generate() {
        const docType = document.getElementById('doc-type-select').value;
        const config = this.docTypes[docType];
        const info = this.collectInfo();
        const hasUserInput = Array.from(document.querySelectorAll('[data-field]'))
            .some(el => el.value.trim()) || document.getElementById('doc-extra-input').value.trim() || this.selectedFiles.length > 0;
        if (!hasUserInput) {
            alert('请至少填写一项文书信息，或上传一份案件资料');
            return;
        }
        this.checkMissing();
        const btn = document.getElementById('doc-generate-workbench-btn');
        btn.disabled = true;
        this.setStatus(this.selectedFiles.length ? '正在读取资料并生成文书初稿...' : '正在生成文书初稿...');
        try {
            const files = await this.readFilesAsBase64();
            const result = await API.generateDocument(docType, info, files);
            this.currentContent = result.content || '';
            this.currentTitle = this.extractTitle(this.currentContent) || config.name;
            this.renderPreview(this.currentContent);
            this.setStatus('生成完成，可以继续复制或导出 Word');
        } catch (e) {
            this.setStatus(`生成失败：${e.message}`);
        } finally {
            btn.disabled = false;
        }
    },

    renderPreview(content) {
        const preview = document.getElementById('doc-preview-content');
        preview.className = 'document-preview-content';
        preview.innerHTML = this.renderMarkdown(content);
        document.getElementById('doc-preview-subtitle').textContent = this.currentTitle;
    },

    async copyContent() {
        if (!this.currentContent) {
            alert('还没有可复制的文书内容');
            return;
        }
        await navigator.clipboard.writeText(this.currentContent);
        this.setStatus('已复制到剪贴板');
    },

    async downloadWord() {
        if (!this.currentContent) {
            alert('请先生成文书');
            return;
        }
        this.setStatus('正在生成 Word 文件...');
        try {
            await API.exportWord(this.currentContent, this.currentTitle || '法律文书');
            this.setStatus('Word 下载已开始');
        } catch (e) {
            this.setStatus(`导出失败：${e.message}`);
        }
    },

    clearFields() {
        document.querySelectorAll('[data-field], #doc-extra-input').forEach(el => {
            el.value = '';
        });
        this.selectedFiles = [];
        this.renderFiles();
        this.hideMissing();
        this.setStatus('已清空当前表单');
    },

    setStatus(text) {
        const el = document.getElementById('doc-status');
        el.textContent = text;
        el.classList.remove('hidden');
    },

    hideMissing() {
        document.getElementById('doc-missing-list').classList.add('hidden');
    },

    extractTitle(content) {
        const m = content.match(/^#\s+(.+)/m) || content.match(/^(.{2,40}(起诉状|答辩状|律师函|法律意见书|合同|协议))/m);
        return m ? m[1].trim() : '';
    },

    renderMarkdown(text) {
        if (typeof marked === 'undefined') return this.escape(text).replace(/\n/g, '<br>');
        return marked.parse(text || '', { breaks: true, gfm: true });
    },

    applyTheme() {
        const username = this.user?.username;
        document.body.classList.toggle('theme-cold', !!username && username !== 'loveHmt');
        if (username) {
            document.getElementById('document-greeting').textContent = `${username}，文书工作台已就绪`;
        }
    },

    escape(text) {
        const d = document.createElement('div');
        d.textContent = text || '';
        return d.innerHTML;
    },
};

document.addEventListener('DOMContentLoaded', () => DocumentWorkbench.init());
