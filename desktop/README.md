# AI 法律小助手桌面端

这是一个独立的 Electron 桌面壳，会打开线上服务：

```text
http://47.116.213.107
```

## 开发运行

```bash
npm install
npm start
```

## 打包

macOS：

```bash
npm run dist:mac
```

Windows：

```bash
npm run dist:win
```

全部平台：

```bash
npm run dist
```

打包产物会输出到 `release/`。

## 说明

- 默认窗口标题：`AI 法律小助手`
- 默认加载地址：`http://47.116.213.107`
- 可以通过环境变量覆盖地址：

```bash
AI_LAW_HELPER_URL=http://你的服务器地址 npm start
```

- 当前图标文件：
  - `assets/icon.png`：窗口图标和 macOS 打包图标
  - `assets/icon.ico`：Windows 打包图标
  - `assets/icon.svg`：图标源稿
