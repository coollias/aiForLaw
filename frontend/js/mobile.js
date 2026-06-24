const MobileApp = {
    scene: 'general',
    sessions: [],
    currentUser: null,
    currentSessionId: '',
    canManageUsers: false,
    selectedFiles: [],
    isStreaming: false,
    sceneNames: {
        general: '法律问答',
        research: '查法查案',
        contract: '审查合同',
        document: '写文书',
    },

    async init() {
        this.bind();
        await this.checkAuth();
        this.applyLoginThemePreview();
    },

    bind() {
        this.$('m-login-btn').addEventListener('click', () => this.login());
        this.$('m-password').addEventListener('keydown', e => { if (e.key === 'Enter') this.login(); });
        this.$('m-username').addEventListener('input', () => this.applyLoginThemePreview());
        this.$('m-send-btn').addEventListener('click', () => this.send());
        this.$('m-input').addEventListener('input', () => this.autosize());
        this.$('m-attach-btn').addEventListener('click', () => this.$('m-file-input').click());
        this.$('m-file-input').addEventListener('change', () => this.addFiles());
        this.$('m-session-btn').addEventListener('click', () => this.openDrawer());
        this.$('m-drawer-mask').addEventListener('click', () => this.closeDrawer());
        this.$('m-new-session').addEventListener('click', () => this.newSession());
        this.$('m-logout-btn').addEventListener('click', () => this.logout());
        this.$('m-admin-btn').addEventListener('click', () => this.openAdmin());
        this.$('m-admin-back').addEventListener('click', () => this.closeAdmin());
        this.$('m-create-user-btn').addEventListener('click', () => this.createUser());
        document.querySelectorAll('.m-tabs button').forEach(btn => {
            btn.addEventListener('click', () => this.setScene(btn.dataset.scene));
        });
        document.querySelectorAll('[data-quick]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.$('m-input').value = btn.dataset.quick;
                this.send();
            });
        });
    },

    async checkAuth() {
        try {
            const auth = await API.checkAuth();
            if (auth.authenticated) {
                this.currentUser = auth.user;
                this.currentSessionId = auth.current_session || '';
                this.showApp();
                await this.loadSessions();
                await this.loadMessages();
            } else {
                this.showLogin();
            }
        } catch (e) {
            this.showLogin();
        }
    },

    async login() {
        const username = this.$('m-username').value.trim();
        const password = this.$('m-password').value.trim();
        if (!username || !password) return;
        this.$('m-login-btn').disabled = true;
        this.$('m-login-error').classList.add('hidden');
        try {
            const res = await API.login(username, password);
            this.currentUser = res.user;
            this.currentSessionId = res.current_session || '';
            this.sessions = res.sessions || [];
            this.showApp();
            await this.loadSessions();
            await this.loadMessages();
        } catch (e) {
            this.$('m-login-error').textContent = e.message || '登录失败';
            this.$('m-login-error').classList.remove('hidden');
        } finally {
            this.$('m-login-btn').disabled = false;
        }
    },

    showLogin() {
        this.$('mobile-login').classList.remove('hidden');
        this.$('mobile-app').classList.add('hidden');
        this.applyLoginThemePreview();
    },

    showApp() {
        this.$('mobile-login').classList.add('hidden');
        this.$('mobile-app').classList.remove('hidden');
        this.applyUserTheme();
        this.canManageUsers = !!this.currentUser?.is_admin || this.currentUser?.username === 'loveHmt';
        this.$('m-admin-btn').classList.toggle('hidden', !this.canManageUsers);
        this.updateHeader();
    },

    applyUserTheme() {
        document.body.classList.toggle('theme-warm', this.currentUser?.username === 'loveHmt');
    },

    applyLoginThemePreview() {
        document.body.classList.remove('theme-warm');
    },

    updateHeader() {
        this.$('m-title').textContent = this.sceneNames[this.scene] || '法律助手';
        this.$('m-status').textContent = '系统在线 · 权限已校验';
    },

    setScene(scene) {
        this.scene = scene;
        document.querySelectorAll('.m-tabs button').forEach(btn => btn.classList.toggle('active', btn.dataset.scene === scene));
        const tips = {
            general: '输入你的法律问题...',
            research: '输入法规、案例或关键词...',
            contract: '粘贴合同内容或上传文件...',
            document: '描述要生成的文书...',
        };
        this.$('m-input').placeholder = tips[scene] || tips.general;
        this.closeAdmin();
        this.updateHeader();
    },

    async loadSessions() {
        const data = await API.getSessions();
        this.sessions = data.sessions || [];
        this.currentSessionId = data.current_session || this.currentSessionId;
        this.currentUser = data.user || this.currentUser;
        this.showApp();
        this.renderSessions();
    },

    renderSessions() {
        this.$('m-session-list').innerHTML = this.sessions.map(s => `
            <button class="m-session-item ${s.id === this.currentSessionId ? 'active' : ''}" data-id="${s.id}">
                ${this.escape(s.title || '新对话')}
            </button>
        `).join('') || '<div class="m-status">暂无对话</div>';
        this.$('m-session-list').querySelectorAll('[data-id]').forEach(btn => {
            btn.addEventListener('click', () => this.switchSession(btn.dataset.id));
        });
    },

    async switchSession(id) {
        await API.switchSession(id);
        this.currentSessionId = id;
        this.closeDrawer();
        this.renderSessions();
        await this.loadMessages();
    },

    async newSession() {
        const res = await API.newSession('新对话');
        this.currentSessionId = res.session_id;
        this.closeDrawer();
        this.clearMessages();
        await this.loadSessions();
    },

    async loadMessages() {
        this.clearMessages();
        const messages = await API.getMessages();
        if (messages.length) this.$('m-welcome').classList.add('hidden');
        messages.forEach(msg => this.renderMessage(msg.role, msg.content || ''));
        this.scrollBottom();
    },

    clearMessages() {
        this.$('m-messages').innerHTML = '';
        this.$('m-welcome').classList.remove('hidden');
    },

    addFiles() {
        for (const file of this.$('m-file-input').files) {
            if (file.size > 20 * 1024 * 1024) {
                alert(`文件「${file.name}」超过 20MB`);
                continue;
            }
            this.selectedFiles.push(file);
        }
        this.$('m-file-input').value = '';
        this.renderFiles();
    },

    renderFiles() {
        const box = this.$('m-files');
        box.classList.toggle('hidden', !this.selectedFiles.length);
        box.innerHTML = this.selectedFiles.map((file, index) => `
            <span class="m-file-tag">${this.escape(file.name)} <b data-remove="${index}">×</b></span>
        `).join('');
        box.querySelectorAll('[data-remove]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectedFiles.splice(Number(btn.dataset.remove), 1);
                this.renderFiles();
            });
        });
    },

    async readFiles() {
        const result = [];
        for (const file of this.selectedFiles) {
            result.push(await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const dataUrl = reader.result;
                    resolve({
                        name: file.name,
                        mime_type: dataUrl.substring(5, dataUrl.indexOf(';')),
                        data: dataUrl.substring(dataUrl.indexOf(',') + 1),
                    });
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            }));
        }
        return result;
    },

    async send() {
        if (this.isStreaming) return;
        const message = this.$('m-input').value.trim();
        const hasFiles = this.selectedFiles.length > 0;
        if (!message && !hasFiles) return;
        const files = await this.readFiles();
        this.$('m-welcome').classList.add('hidden');
        this.renderMessage('user', message || `发送了 ${files.length} 个文件`);
        this.$('m-input').value = '';
        this.autosize();
        this.selectedFiles = [];
        this.renderFiles();
        const aiEl = this.renderMessage('assistant', '');
        const statusEl = this.renderWorkflow('正在进入工作流');
        let full = '';
        this.isStreaming = true;
        this.$('m-send-btn').disabled = true;
        API.chatStream(
            message,
            this.scene,
            files,
            chunk => {
                full += chunk;
                aiEl.querySelector('.m-bubble').innerHTML = this.markdown(full);
                this.scrollBottom();
            },
            async () => {
                statusEl.remove();
                this.isStreaming = false;
                this.$('m-send-btn').disabled = false;
                aiEl.querySelector('.m-bubble').innerHTML = this.markdown(full);
                await this.loadSessions().catch(() => {});
            },
            error => {
                statusEl.remove();
                this.isStreaming = false;
                this.$('m-send-btn').disabled = false;
                aiEl.querySelector('.m-bubble').textContent = `请求失败：${error}`;
            },
            event => {
                statusEl.textContent = event?.status || '正在处理';
                this.scrollBottom();
            }
        );
    },

    renderMessage(role, content) {
        const el = document.createElement('div');
        el.className = `m-msg ${role}`;
        el.innerHTML = `<div class="m-bubble">${role === 'assistant' ? this.markdown(content) : this.escape(content)}</div>`;
        this.$('m-messages').appendChild(el);
        this.scrollBottom();
        return el;
    },

    renderWorkflow(text) {
        const el = document.createElement('div');
        el.className = 'm-workflow';
        el.textContent = text;
        this.$('m-messages').appendChild(el);
        return el;
    },

    async openAdmin() {
        try {
            await this.loadUsers();
            this.$('m-chat-view').classList.add('hidden');
            this.$('m-admin-view').classList.remove('hidden');
            this.$('m-title').textContent = '用户管理';
        } catch (e) {
            alert('当前账号没有用户管理权限');
        }
    },

    closeAdmin() {
        this.$('m-admin-view').classList.add('hidden');
        this.$('m-chat-view').classList.remove('hidden');
        this.updateHeader();
    },

    async loadUsers() {
        const data = await API.listUsers();
        const users = data.users || [];
        const active = users.filter(u => u.is_active).length;
        const admins = users.filter(u => u.is_admin).length;
        this.$('m-user-summary').textContent = `${users.length} 个账号 · ${active} 个启用 · ${admins} 个管理员`;
        this.$('m-user-list').innerHTML = users.map(user => `
            <div class="m-user-card" data-user-id="${user.id}">
                <strong>${this.escape(user.username)}</strong>
                <div class="m-user-tags">
                    <span class="m-tag ${user.is_admin ? 'admin' : ''}">${user.is_admin ? '管理员' : '普通用户'}</span>
                    <span class="m-tag ${user.is_active ? '' : 'off'}">${user.is_active ? '启用' : '停用'}</span>
                </div>
                <div class="m-user-actions">
                    <button data-action="password">改密码</button>
                    <button data-action="admin" ${user.id === this.currentUser?.id ? 'disabled' : ''}>${user.is_admin ? '取消管理员' : '设管理员'}</button>
                    <button data-action="active" ${user.id === this.currentUser?.id ? 'disabled' : ''}>${user.is_active ? '停用' : '启用'}</button>
                </div>
            </div>
        `).join('');
        this.$('m-user-list').querySelectorAll('.m-user-card').forEach((card, index) => {
            const user = users[index];
            card.querySelector('[data-action="password"]').addEventListener('click', async () => {
                const password = prompt(`请输入 ${user.username} 的新密码`);
                if (password) await this.updateUser(user.id, { password });
            });
            card.querySelector('[data-action="admin"]').addEventListener('click', () => this.updateUser(user.id, { is_admin: !user.is_admin }));
            card.querySelector('[data-action="active"]').addEventListener('click', () => this.updateUser(user.id, { is_active: !user.is_active }));
        });
    },

    async createUser() {
        const username = this.$('m-new-username').value.trim();
        const password = this.$('m-new-password').value.trim();
        const isAdmin = this.$('m-new-admin').checked;
        if (!username || !password) return alert('请填写用户名和初始密码');
        await API.createUser(username, password, isAdmin);
        this.$('m-new-username').value = '';
        this.$('m-new-password').value = '';
        this.$('m-new-admin').checked = false;
        await this.loadUsers();
    },

    async updateUser(id, updates) {
        await API.updateUser(id, updates);
        await this.loadUsers();
    },

    async logout() {
        await API.logout().catch(() => {});
        this.currentUser = null;
        this.showLogin();
    },

    openDrawer() { this.renderSessions(); this.$('m-session-drawer').classList.remove('hidden'); },
    closeDrawer() { this.$('m-session-drawer').classList.add('hidden'); },
    autosize() {
        const input = this.$('m-input');
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 116) + 'px';
    },
    scrollBottom() { this.$('m-chat-view').scrollTop = this.$('m-chat-view').scrollHeight; },
    markdown(text) {
        if (!text) return '';
        if (typeof marked === 'undefined') return this.escape(text).replace(/\n/g, '<br>');
        return marked.parse(text, { breaks: true, gfm: true });
    },
    escape(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    },
    $(id) { return document.getElementById(id); },
};

document.addEventListener('DOMContentLoaded', () => MobileApp.init());
