/**
 * AI 法律小助手 — 主应用逻辑
 * 登录、场景切换、多会话管理、文书弹窗等
 */

const App = {
    currentScene: 'general',
    sessions: [],
    currentSessionId: '',
    currentUser: null,
    canManageUsers: false,

    // 场景配置
    scenes: {
        general: { name: '💬 法律问答', icon: '💬' },
        document: { name: '📝 写文书', icon: '📝' },
        research: { name: '📚 查法规/案例', icon: '📚' },
        contract: { name: '📋 审查合同', icon: '📋' },
        hallucination: { name: '✓ 幻觉校验', icon: '✓' },
    },

    // 文书类型对应的字段
    docFields: {
        complaint: { name: '起诉状', fields: ['原告信息', '被告信息', '诉讼请求', '事实与理由', '证据清单'] },
        defense: { name: '答辩状', fields: ['答辩人信息', '被答辩人信息', '案由', '答辩意见', '事实与理由'] },
        legal_opinion: { name: '法律意见书', fields: ['委托人', '委托事项', '背景情况', '法律分析要点', '期望结论'] },
        contract: { name: '合同/协议', fields: ['合同类型', '甲方信息', '乙方信息', '核心条款', '特别约定'] },
        lawyer_letter: { name: '律师函', fields: ['委托人', '收函方名称', '委托事项', '事实背景', '法律依据', '具体要求'] },
    },

    async init() {
        const auth = await API.checkAuth();
        const authed = !!auth.authenticated;
        this.currentUser = auth.user || null;
        this.canManageUsers = !!this.currentUser?.is_admin;
        this.applyUserTheme();
        if (authed) {
            await this.loadSessions();
            this.showApp();
        } else {
            this.showLogin();
        }

        this.bindLogin();
        Chat.init();
        ContractWorkbench.init();
        HallucinationWorkbench.init();
        this.bindScenes();
        this.bindDocButtons();
        this.bindSessions();
        this.bindDocModal();
        this.bindUserAdmin();
        this.updateGreeting();

        // 如果已登录，加载会话列表
        if (authed) {
            await this.loadSessions();
            await this.loadMessagesForCurrentSession();
        }

        // 绑定清空/退出
        document.getElementById('clear-chat-btn').addEventListener('click', () => Chat.clear());
        document.getElementById('logout-btn').addEventListener('click', () => this.logout());
    },

    // ===== 登录 =====
    showLogin() {
        document.getElementById('login-page').classList.remove('hidden');
        document.getElementById('app-page').classList.add('hidden');
        this.applyLoginThemePreview();
        document.getElementById('password-input').focus();
    },

    showApp() {
        document.getElementById('login-page').classList.add('hidden');
        document.getElementById('app-page').classList.remove('hidden');
        this.applyUserTheme();
        this.updateGreeting();
        this.updateAdminEntrypoints();
        // 兜底：500ms 后再次检查，防止时序问题导致按钮不显示
        setTimeout(() => this.updateAdminEntrypoints(), 500);
        document.getElementById('chat-input').focus();
    },

    updateAdminEntrypoints() {
        const looksLikeBootstrapAdmin = this.currentUser?.username === 'loveHmt';
        const shouldShow = this.canManageUsers || looksLikeBootstrapAdmin;
        document.querySelectorAll('[data-admin-entry]').forEach(btn => {
            if (shouldShow) {
                btn.classList.remove('hidden');
            } else {
                btn.classList.add('hidden');
            }
        });
    },

    async refreshAdminPermission() {
        if (this.currentUser?.is_admin) {
            this.canManageUsers = true;
            this.updateAdminEntrypoints();
            return true;
        }

        try {
            await API.listUsers();
            this.canManageUsers = true;
        } catch (e) {
            this.canManageUsers = false;
        }
        this.updateAdminEntrypoints();
        return this.canManageUsers;
    },

    bindLogin() {
        const input = document.getElementById('password-input');
        const usernameInput = document.getElementById('username-input');
        const btn = document.getElementById('login-btn');
        const error = document.getElementById('login-error');

        const doLogin = async () => {
            const username = usernameInput.value.trim() || 'admin';
            const password = input.value.trim();
            if (!username || !password) return;

            btn.disabled = true;
            btn.querySelector('span').textContent = '验证中...';
            error.classList.add('hidden');

            try {
                const result = await API.login(username, password);
                this.currentUser = result.user || null;
                this.canManageUsers = !!this.currentUser?.is_admin;
                this.applyUserTheme();
                this.sessions = result.sessions || [];
                this.currentSessionId = result.current_session || '';
                this.renderSessionList();
                this.showApp();
                await this.refreshAdminPermission();
                await this.loadMessagesForCurrentSession();
            } catch (e) {
                error.textContent = e.message === 'Unauthorized' ? '密码错误，请重试' : e.message;
                error.classList.remove('hidden');
                input.value = '';
                usernameInput.focus();
                input.focus();
                input.style.animation = 'shake 0.4s ease';
                setTimeout(() => input.style.animation = '', 400);
            } finally {
                btn.disabled = false;
                btn.querySelector('span').textContent = '进入';
            }
        };

        btn.addEventListener('click', doLogin);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
        usernameInput.addEventListener('input', () => this.applyLoginThemePreview());
    },

    // ===== 会话管理 =====
    bindSessions() {
        document.getElementById('new-session-btn').addEventListener('click', () => this.createNewSession());
    },

    async loadSessions() {
        try {
            const data = await API.getSessions();
            this.sessions = data.sessions || [];
            this.currentSessionId = data.current_session || '';
            this.currentUser = data.user || this.currentUser;
            this.canManageUsers = this.canManageUsers || !!this.currentUser?.is_admin;
            this.applyUserTheme();
            this.updateGreeting();
            this.updateAdminEntrypoints();
            this.renderSessionList();
        } catch (e) { /* ignore */ }
    },

    renderSessionList() {
        const container = document.getElementById('session-list');
        if (!this.sessions.length) {
            container.innerHTML = '<div class="session-item" style="color:var(--text-muted);cursor:default;">暂无对话</div>';
            return;
        }

        container.innerHTML = this.sessions.map(s => {
            const isActive = s.id === this.currentSessionId;
            const title = s.title || '新对话';
            const dt = new Date(s.created_at * 1000);
            const timeStr = dt.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
            return `
                <div class="session-item ${isActive ? 'active' : ''}" data-session-id="${s.id}">
                    <span class="session-icon">💬</span>
                    <span class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</span>
                    <span class="session-actions">
                        <button class="rename-session-btn" title="重命名">✏️</button>
                        <button class="delete-session-btn" title="删除">🗑️</button>
                    </span>
                </div>`;
        }).join('');

        // 绑定事件
        container.querySelectorAll('.session-item').forEach(item => {
            item.addEventListener('click', (e) => {
                // 如果点了子按钮就不处理
                if (e.target.closest('.rename-session-btn') || e.target.closest('.delete-session-btn')) return;
                const sid = item.dataset.sessionId;
                if (sid && sid !== this.currentSessionId) {
                    this.switchToSession(sid);
                }
            });
            const renameBtn = item.querySelector('.rename-session-btn');
            const deleteBtn = item.querySelector('.delete-session-btn');
            if (renameBtn) {
                renameBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.renameSession(item.dataset.sessionId);
                });
            }
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.deleteSessionConfirm(item.dataset.sessionId);
                });
            }
        });
    },

    async createNewSession() {
        try {
            const result = await API.newSession('新对话');
            await this.loadSessions();
            // 清空聊天区
            Chat.clear({ remote: false });
            // 切换到新创建的会话
            if (result.session_id) {
                this.currentSessionId = result.session_id;
                this.renderSessionList();
            }
        } catch (e) {
            console.error('创建会话失败:', e);
        }
    },

    async switchToSession(sessionId) {
        try {
            await API.switchSession(sessionId);
            this.currentSessionId = sessionId;
            this.renderSessionList();
            await this.loadMessagesForCurrentSession();
        } catch (e) {
            console.error('切换失败:', e);
        }
    },

    async renameSession(sessionId) {
        const session = this.sessions.find(s => s.id === sessionId);
        const oldTitle = session ? session.title : '新对话';
        const newTitle = prompt('请输入新名称:', oldTitle);
        if (newTitle && newTitle.trim() && newTitle.trim() !== oldTitle) {
            try {
                await API.renameSession(sessionId, newTitle.trim());
                await this.loadSessions();
            } catch (e) {
                console.error('重命名失败:', e);
            }
        }
    },

    async deleteSessionConfirm(sessionId) {
        const session = this.sessions.find(s => s.id === sessionId);
        const title = session ? session.title : '新对话';
        if (!confirm(`确定删除「${title}」吗？此操作不可撤销。`)) return;

        try {
            const result = await API.deleteSession(sessionId);
            // 服务端返回 new_session 说明当前会话被删了
            if (result.new_session) {
                this.currentSessionId = result.new_session;
            }
            await this.loadSessions();
            await this.loadMessagesForCurrentSession();
        } catch (e) {
            console.error('删除失败:', e);
        }
    },

    async loadMessagesForCurrentSession() {
        Chat.clear({ remote: false });
        try {
            const messages = await API.getMessages();
            if (!messages.length) return;

            Chat.el.welcome.classList.add('hidden');
            for (const msg of messages) {
                if (msg.role === 'assistant') {
                    const aiEl = Chat.createAIMessagePlaceholder();
                    Chat.finalizeAIMessage(aiEl, msg.content || '');
                } else if (msg.role === 'user') {
                    Chat.renderMessage('user', msg.content || '');
                }
            }
            Chat.scrollToBottom();
        } catch (e) {
            console.error('加载历史消息失败:', e);
        }
    },

    // ===== 场景切换 =====
    bindScenes() {
        const buttons = document.querySelectorAll('.scene-btn');
        const docPanel = document.getElementById('doc-quick-panel');
        const currentSceneEl = document.getElementById('current-scene');

        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const scene = btn.dataset.scene;
                if (scene === 'document') {
                    window.location.href = '/document';
                    return;
                }
                if (scene === 'research') {
                    window.location.href = '/research';
                    return;
                }
                if (!document.getElementById('user-admin-page').classList.contains('hidden')) {
                    this.closeUserPage();
                }
                if (scene !== 'contract' && !document.getElementById('contract-workbench').classList.contains('hidden')) {
                    ContractWorkbench.close();
                }
                if (scene !== 'hallucination' && !document.getElementById('hall-workbench').classList.contains('hidden')) {
                    HallucinationWorkbench.close();
                }
                buttons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentScene = scene;
                currentSceneEl.textContent = this.scenes[scene]?.name || scene;
                if (scene === 'contract') {
                    docPanel.classList.add('hidden');
                    ContractWorkbench.open();
                    return;
                }
                if (scene === 'hallucination') {
                    docPanel.classList.add('hidden');
                    HallucinationWorkbench.open();
                    return;
                }
                if (scene === 'document') {
                    docPanel.classList.remove('hidden');
                } else {
                    docPanel.classList.add('hidden');
                }
                const hints = {
                    general: '输入你的法律问题...',
                    document: '描述你需要撰写的文书内容...',
                    research: '输入你想查询的法律法规或案例关键词...',
                    contract: '粘贴你需要审查的合同内容...',
                    hallucination: '粘贴需要校验法律引用的文本...',
                };
                document.getElementById('chat-input').placeholder = hints[scene] || hints.general;
            });
        });
    },

    bindDocButtons() {
        document.querySelectorAll('.doc-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                window.location.href = `/document?type=${encodeURIComponent(btn.dataset.doc || '')}`;
            });
        });
    },

    bindDocModal() {
        document.getElementById('doc-cancel-btn').addEventListener('click', () => this.closeDocModal());
        document.getElementById('doc-generate-btn').addEventListener('click', () => this.generateDocument());
        document.getElementById('doc-modal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) this.closeDocModal();
        });
    },

    bindUserAdmin() {
        document.querySelectorAll('[data-admin-entry]').forEach(btn => {
            btn.addEventListener('click', () => this.openUserPage());
        });
        document.getElementById('user-page-back-btn').addEventListener('click', () => this.closeUserPage());
        document.getElementById('refresh-users-btn').addEventListener('click', () => this.loadUsers());
        document.getElementById('create-user-btn').addEventListener('click', () => this.createUserFromPage());
    },

    async openUserPage() {
        const allowed = await this.refreshAdminPermission();
        if (!allowed) {
            alert('当前账号没有用户管理权限');
            return;
        }
        document.getElementById('contract-workbench')?.classList.add('hidden');
        document.getElementById('hall-workbench')?.classList.add('hidden');
        document.getElementById('chat-area').classList.add('hidden');
        document.querySelector('.input-area').classList.add('hidden');
        document.getElementById('user-admin-page').classList.remove('hidden');
        document.getElementById('current-scene').textContent = '👥 用户管理';
        await this.loadUsers();
    },

    closeUserPage() {
        document.getElementById('user-admin-page').classList.add('hidden');
        document.getElementById('chat-area').classList.remove('hidden');
        document.querySelector('.input-area').classList.remove('hidden');
        document.getElementById('current-scene').textContent = this.scenes[this.currentScene]?.name || '💬 法律问答';
        document.getElementById('chat-input').focus();
    },

    async loadUsers() {
        const list = document.getElementById('user-list');
        list.innerHTML = '<div class="session-item" style="cursor:default;">加载中...</div>';
        try {
            const data = await API.listUsers();
            const users = data.users || [];
            const adminCount = users.filter(user => user.is_admin).length;
            const activeCount = users.filter(user => user.is_active).length;
            document.getElementById('user-list-summary').textContent = `共 ${users.length} 个账号，${activeCount} 个启用，${adminCount} 个管理员`;
            list.innerHTML = users.map(user => `
                <div class="user-item" data-user-id="${user.id}">
                    <div class="user-meta">
                        <div class="user-name">${this.escapeHtml(user.username)}</div>
                        <div class="user-tags">
                            ${user.is_admin ? '<span class="user-tag admin">管理员</span>' : '<span class="user-tag">普通用户</span>'}
                            ${user.is_active ? '<span class="user-tag">启用</span>' : '<span class="user-tag disabled">停用</span>'}
                        </div>
                    </div>
                    <label class="check-row">
                        <input type="checkbox" class="admin-toggle" ${user.is_admin ? 'checked' : ''} ${user.id === this.currentUser?.id ? 'disabled' : ''}>
                        管理员
                    </label>
                    <div class="user-actions">
                        <button class="mini-btn reset-password-btn">改密码</button>
                        <button class="mini-btn active-toggle-btn" ${user.id === this.currentUser?.id ? 'disabled' : ''}>${user.is_active ? '停用' : '启用'}</button>
                    </div>
                </div>
            `).join('');

            list.querySelectorAll('.user-item').forEach((item, index) => {
                const user = users[index];
                item.querySelector('.admin-toggle').addEventListener('change', async (e) => {
                    await this.updateUser(user.id, { is_admin: e.target.checked });
                });
                item.querySelector('.reset-password-btn').addEventListener('click', async () => {
                    const password = prompt(`请输入 ${user.username} 的新密码：`);
                    if (password) await this.updateUser(user.id, { password });
                });
                item.querySelector('.active-toggle-btn').addEventListener('click', async () => {
                    await this.updateUser(user.id, { is_active: !user.is_active });
                });
            });
        } catch (e) {
            document.getElementById('user-list-summary').textContent = '用户信息加载失败';
            list.innerHTML = `<div class="session-item" style="cursor:default;color:#e8496a;">${this.escapeHtml(e.message)}</div>`;
        }
    },

    async createUserFromPage() {
        const usernameEl = document.getElementById('new-username-input');
        const passwordEl = document.getElementById('new-password-input');
        const adminEl = document.getElementById('new-is-admin-input');
        const username = usernameEl.value.trim();
        const password = passwordEl.value.trim();
        if (!username || !password) {
            alert('请填写用户名和初始密码');
            return;
        }
        try {
            await API.createUser(username, password, adminEl.checked);
            usernameEl.value = '';
            passwordEl.value = '';
            adminEl.checked = false;
            await this.loadUsers();
        } catch (e) {
            alert(e.message);
        }
    },

    async updateUser(userId, updates) {
        try {
            await API.updateUser(userId, updates);
            await this.loadUsers();
        } catch (e) {
            alert(e.message);
            await this.loadUsers();
        }
    },

    openDocModal(docType) {
        const config = this.docFields[docType];
        if (!config) return;
        const modal = document.getElementById('doc-modal');
        document.getElementById('doc-modal-title').textContent = `📝 生成${config.name}`;
        document.getElementById('doc-modal-body').innerHTML = config.fields.map((field, i) => `
            <div class="form-group">
                <label>${field}</label>
                ${i < 2 ? `<input type="text" data-field="${field}" placeholder="请输入${field}">`
                         : `<textarea data-field="${field}" placeholder="请输入${field}"></textarea>`}
            </div>
        `).join('');
        modal.dataset.docType = docType;
        modal.classList.remove('hidden');
    },

    closeDocModal() {
        document.getElementById('doc-modal').classList.add('hidden');
    },

    async generateDocument() {
        const modal = document.getElementById('doc-modal');
        const docType = modal.dataset.docType;
        const generateBtn = document.getElementById('doc-generate-btn');
        const info = {};
        modal.querySelectorAll('[data-field]').forEach(el => { info[el.dataset.field] = el.value.trim(); });
        const hasContent = Object.values(info).some(v => v);
        if (!hasContent) { alert('请至少填写一个字段的内容哦~'); return; }
        generateBtn.disabled = true;
        generateBtn.textContent = '生成中...';
        try {
            const result = await API.generateDocument(docType, info);
            this.closeDocModal();
            if (result.content) {
                Chat.el.welcome.classList.add('hidden');
                Chat.renderMessage('user', `请帮我生成一份${this.docFields[docType]?.name || '文书'}`);
                const aiEl = Chat.createAIMessagePlaceholder();
                Chat.finalizeAIMessage(aiEl, result.content);
                Chat.scrollToBottom();
            }
        } catch (e) {
            alert('生成失败：' + e.message);
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = '生成';
        }
    },

    async logout() {
        await API.logout().catch(() => {});
        this.currentUser = null;
        this.canManageUsers = false;
        this.applyUserTheme();
        this.updateAdminEntrypoints();
        Chat.clear({ remote: false });
        this.showLogin();
    },

    isWarmThemeUser() {
        return this.isWarmUsername(this.currentUser?.username);
    },

    isWarmUsername(username) {
        return username === 'loveHmt';
    },

    applyUserTheme() {
        const useColdTheme = !!this.currentUser && !this.isWarmThemeUser();
        document.body.classList.toggle('theme-cold', useColdTheme);
    },

    applyLoginThemePreview() {
        document.body.classList.add('theme-cold');
    },

    updateGreeting() {
        const el = document.getElementById('greeting');
        if (this.isWarmThemeUser()) {
            const h = new Date().getHours();
            let g;
            if (h < 6) g = '夜深了，注意休息 🌙';
            else if (h < 9) g = '早上好呀 ☀️';
            else if (h < 12) g = '上午好 🌻';
            else if (h < 14) g = '中午好，记得吃饭 🍱';
            else if (h < 18) g = '下午好 🍵';
            else if (h < 21) g = '晚上好 🌆';
            else g = '晚安，辛苦了 🌙';
            el.textContent = g;
            return;
        }
        el.textContent = '系统在线 · 权限已校验';
    },

    escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    },
};

function quickAsk(question) {
    Chat.sendQuick(question);
}

document.addEventListener('DOMContentLoaded', () => App.init());
