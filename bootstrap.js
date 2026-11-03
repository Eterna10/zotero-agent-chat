/* global Zotero, Services */
/* eslint-disable no-unused-vars */

var AgentChat;

function install() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "content/agent-chat.js");
  AgentChat.init({ id, version, rootURI });
  AgentChat.startup();
  for (const win of Zotero.getMainWindows()) {
    if (win.ZoteroPane) AgentChat.addToWindow(win);
  }
}

function onMainWindowLoad({ window }) {
  if (AgentChat) AgentChat.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  if (AgentChat) AgentChat.removeFromWindow(window);
}

function shutdown() {
  if (AgentChat) AgentChat.shutdown();
  AgentChat = undefined;
}

function uninstall() {}
