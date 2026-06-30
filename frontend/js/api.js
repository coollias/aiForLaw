/**
 * AI 法律小助手 — API 调用层
 */

const API = {
    /**
     * POST 请求
     */
    async post(url, data = {}) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',  // 关键：携带 cookie
            body: JSON.stringify(data),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: '请求失败' }));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        return res;
    },

    /**
     * GET 请求
     */
    async get(url) {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('请求失败');
        return res.json();
    },

    /**
     * 检查登录状态
     */
    async checkAuth() {
        return this.get('/api/check-auth');
    },

    /**
     * 登录 — 返回会话列表
     */
    async login(username, password) {
        const res = await this.post('/api/login', { username, password });
        return res.json();
    },

    async listUsers() {
        return this.get('/api/admin/users');
    },

    async createUser(username, password, isAdmin) {
        const res = await this.post('/api/admin/users', {
            username,
            password,
            is_admin: !!isAdmin,
        });
        return res.json();
    },

    async updateUser(userId, updates) {
        const res = await this.post('/api/admin/users/update', {
            user_id: userId,
            ...updates,
        });
        return res.json();
    },

    /**
     * 获取会话列表
     */
    async getSessions() {
        const data = await this.get('/api/sessions');
        return data;
    },

    /**
     * 获取当前会话消息
     */
    async getMessages() {
        const data = await this.get('/api/messages');
        return data.messages || [];
    },

    /**
     * 创建新会话
     */
    async newSession(title) {
        const res = await this.post('/api/sessions/new', { title: title || '新对话' });
        return res.json();
    },

    /**
     * 切换会话
     */
    async switchSession(sessionId) {
        const res = await this.post('/api/sessions/switch', { session_id: sessionId });
        return res.json();
    },

    /**
     * 重命名会话
     */
    async renameSession(sessionId, title) {
        return this.post('/api/sessions/rename', { session_id: sessionId, title });
    },

    /**
     * 删除会话
     */
    async deleteSession(sessionId) {
        return this.post('/api/sessions/delete', { session_id: sessionId });
    },

    /**
     * 退出登录
     */
    async logout() {
        await this.post('/api/logout');
    },

    /**
     * 流式对话（支持附件）
     * @param {string} message - 用户消息
     * @param {string} scene - 场景类型
     * @param {Array} files - 附件列表 [{name, mime_type, data(base64)}]
     */
    async chatStream(message, scene, files, onChunk, onDone, onError, onStatus, onReferences, options = {}) {
        try {
            const web_search_enabled = options.webSearchEnabled === true;
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    message,
                    scene,
                    files: files || [],
                    display_message: options.displayMessage || '',
                    web_search_enabled,  // 联网搜索开关
                }),
            });

            if (!res.ok) {
                if (res.status === 401) {
                    onError('请先登录');
                    // 跳转登录页
                    document.getElementById('app-page')?.classList.add('hidden');
                    document.getElementById('login-page')?.classList.remove('hidden');
                    document.getElementById('mobile-app')?.classList.add('hidden');
                    document.getElementById('mobile-login')?.classList.remove('hidden');
                    return;
                }
                const err = await res.json().catch(() => ({ detail: '请求失败' }));
                onError(err.detail || '请求失败');
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') {
                        onDone();
                        return;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            onError(parsed.error);
                            return;
                        }
                        if (parsed.content) {
                            onChunk(parsed.content);
                        }
                        if (parsed.status && onStatus) {
                            onStatus(parsed);
                        }
                        if (parsed.references && onReferences) {
                            onReferences(parsed.references, parsed);
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
            onDone();
        } catch (e) {
            onError(e.message || '网络错误');
        }
    },

    /**
     * 清空对话
     */
    async clearChat() {
        return this.post('/api/chat-clear');
    },

    async researchStream(payload, onChunk, onDone, onError, onStatus, onReferences, onRecord) {
        try {
            const res = await fetch('/api/research/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload || {}),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: '请求失败' }));
                onError(err.detail || '请求失败');
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') {
                        onDone();
                        return;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            onError(parsed.error);
                            return;
                        }
                        if (parsed.content) onChunk(parsed.content);
                        if (parsed.status && onStatus) onStatus(parsed);
                        if (parsed.references && onReferences) onReferences(parsed.references, parsed);
                        if (parsed.record_id && onRecord) onRecord(parsed.record_id);
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
            onDone();
        } catch (e) {
            onError(e.message || '网络错误');
        }
    },

    async listResearchRecords() {
        return this.get('/api/research/records');
    },

    async getResearchRecord(recordId) {
        return this.get(`/api/research/records/${encodeURIComponent(recordId)}`);
    },

    async researchFollowupStream(payload, onChunk, onDone, onError) {
        try {
            const res = await fetch('/api/research/followup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload || {}),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: '请求失败' }));
                onError(err.detail || '请求失败');
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') {
                        onDone();
                        return;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            onError(parsed.error);
                            return;
                        }
                        if (parsed.content) onChunk(parsed.content);
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
            onDone();
        } catch (e) {
            onError(e.message || '网络错误');
        }
    },

    async deleteResearchRecord(recordId) {
        const res = await fetch(`/api/research/records/${encodeURIComponent(recordId)}`, {
            method: 'DELETE',
            credentials: 'include',
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: '删除失败' }));
            throw new Error(err.detail || '删除失败');
        }
        return res.json();
    },

    async checkHallucination(text) {
        const res = await this.post('/api/hallucination/check', { text });
        return res.json();
    },

    async extractHallucinationFile(file) {
        const res = await this.post('/api/hallucination/extract-file', { file });
        return res.json();
    },

    /**
     * 生成文档
     */
    async generateDocument(docType, info, files) {
        const res = await this.post('/api/document/generate', {
            doc_type: docType,
            info: info,
            files: files || [],
        });
        return res.json();
    },

    async extractDocumentInfo(docType, fields, files, currentInfo) {
        const res = await this.post('/api/document/extract-info', {
            doc_type: docType,
            fields: fields || [],
            files: files || [],
            current_info: currentInfo || {},
        });
        return res.json();
    },

    /**
     * 导出 Word 文档
     */
    async exportWord(content, title) {
        await downloadFile('/api/document/export', { content, title }, `${title}.docx`);
    },

    async reviewContract(file, note, contractType, includeReferences, issueLimit, onProgress) {
        const started = await this.startContractReview(file, note, contractType, includeReferences, issueLimit);
        if (onProgress) onProgress(started.job);
        return this.waitContractReviewJob(started.job.job_id, onProgress);
    },

    async startContractReview(file, note, contractType, includeReferences, issueLimit) {
        const res = await this.post('/api/contract/review/start', {
            file,
            note: note || '',
            contract_type: contractType || 'general',
            include_references: !!includeReferences,
            issue_limit: Number(issueLimit ?? 12),
        });
        return res.json();
    },

    async getContractReviewJob(jobId) {
        return this.get(`/api/contract/review/jobs/${encodeURIComponent(jobId)}`);
    },

    async waitContractReviewJob(jobId, onProgress) {
        while (true) {
            const data = await this.getContractReviewJob(jobId);
            const job = data.job || {};
            if (onProgress) onProgress(job);
            if (job.status === 'done') return job.result;
            if (job.status === 'failed') throw new Error(job.error || job.message || '审查失败');
            await new Promise(resolve => setTimeout(resolve, 1800));
        }
    },

    async askContractFollowup(question, parsedDoc, review, contractType, includeReferences) {
        const res = await this.post('/api/contract/ask', {
            question,
            parsed_doc: parsedDoc || {},
            review: review || {},
            contract_type: contractType || 'general',
            include_references: !!includeReferences,
        });
        return res.json();
    },

    async listContractReviews() {
        return this.get('/api/contract/reviews');
    },

    async getContractReview(reviewId) {
        return this.get(`/api/contract/reviews/${encodeURIComponent(reviewId)}`);
    },

    async deleteContractReview(reviewId) {
        const res = await this.post('/api/contract/reviews/delete', { review_id: reviewId });
        return res.json();
    },
};

/**
 * 下载文件的辅助函数
 */
async function downloadFile(url, body, filename) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '下载失败' }));
        throw new Error(err.detail || '下载失败');
    }

    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
}
