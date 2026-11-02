/* CivicLab · bancada HonDash SPP (experimental; somente consultas lidas no HCI).
   A porta serial Bluetooth e os dados ficam exclusivamente no navegador. */
(() => {
  "use strict";

  const COMMANDS = Object.freeze([
    { id: "78", bytes: "20 05 78 05 5E", length: 5, label: "78 · identificação inicial (5 bytes)" },
    { id: "00", bytes: "20 05 00 03 D8", length: 3, label: "00 · bloco 3 bytes" },
    { id: "10", bytes: "20 05 10 0C BF", length: 12, label: "10 · bloco 12 bytes" },
    { id: "20", bytes: "20 05 20 10 AB", length: 16, label: "20 · bloco 16 bytes" },
    { id: "3C", bytes: "20 05 3C 01 9E", length: 1, label: "3C · bloco 1 byte" },
    { id: "9A", bytes: "20 05 9A 03 3E", length: 3, label: "9A · bloco 3 bytes" },
    { id: "08", bytes: "20 05 08 08 CB", length: 8, label: "08 · bloco 8 bytes" },
    { id: "76", bytes: "20 05 76 02 63", length: 2, label: "76 · bloco 2 bytes" }
  ]);
  const SPP_UUID = "00001101-0000-1000-8000-00805f9b34fb";
  const TIMEOUT_MS = 3500;
  const MAX_LOGS = 5000;

  const el = (id) => document.getElementById(id);
  const $ = {
    support: el("support"), status: el("status"), selected: el("selected"),
    connect: el("connect"), disconnect: el("disconnect"),
    command: el("command"), send: el("send"), probe: el("probe"),
    download: el("download"), clear: el("clear"),
    log: el("log"), count: el("count"), responses: el("responses"),
    last: el("last"), hint: el("hint")
  };

  let port = null;
  let reader = null;
  let readerTask = null;
  let closing = false;
  let busy = false;
  let pending = null;
  let buffer = [];
  let txCount = 0;
  let responseCount = 0;
  let logs = [];
  let sequenceAbort = false;
  const commandById = new Map(COMMANDS.map((command) => [command.id, command]));
  const bytesOf = (hex) => Uint8Array.from(hex.trim().split(/\s+/).map((s) => parseInt(s, 16)));
  const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  const checksumValid = (bytes) => bytes.reduce((a, b) => (a + b) & 255, 0) === 0;

  for (const item of COMMANDS) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    $.command.appendChild(option);
  }

  function log(kind, message) {
    const entry = { time: new Date().toISOString(), kind, message };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();
    const visible = logs.slice(-300);
    $.log.textContent = visible.map((line) =>
      "[" + new Date(line.time).toLocaleTimeString("pt-BR", { hour12: false }) + "] " +
      line.kind.padEnd(5, " ") + " " + line.message).join("\n");
    $.log.scrollTop = $.log.scrollHeight;
    $.count.textContent = String(txCount);
    $.responses.textContent = String(responseCount);
  }

  function setStatus(value, tone = "") {
    $.status.textContent = value;
    $.status.dataset.tone = tone;
  }

  function updateControls() {
    $.connect.disabled = !!port || busy || closing;
    $.disconnect.disabled = !port || closing;
    $.send.disabled = !port || busy || closing;
    $.probe.disabled = !port || busy || closing;
    $.command.disabled = busy || closing;
    $.download.disabled = logs.length === 0;
    $.clear.disabled = busy || closing;
  }

  function errorText(err) {
    if (err && err.name === "NotFoundError") return "Nenhuma porta selecionada.";
    if (err && err.name === "SecurityError") return "Permissão bloqueada. Abra em HTTPS ou http://localhost, no Chrome.";
    if (err && err.name === "NetworkError") return "Falha na comunicação. Feche o HonDash e confirme o pareamento.";
    return (err && err.message) ? err.message : String(err);
  }

  function checkEnvironment() {
    if (!window.isSecureContext) {
      $.support.textContent = "Bloqueado: endereço HTTP na rede local não permite Web Serial. Use HTTPS ou http://localhost:8080 via adb reverse.";
      $.support.className = "notice err";
      return false;
    }
    if (!("serial" in navigator)) {
      $.support.textContent = "Web Serial não disponível neste navegador. Tente o Chrome atualizado para Android (138+) ou Chrome no computador.";
      $.support.className = "notice err";
      return false;
    }
    $.support.textContent = "Web Serial disponível. Pareie o scanner OBD nas configurações Bluetooth do Android antes de conectar.";
    $.support.className = "notice ok";
    return true;
  }

  // Não executa comandos na ECU até que o usuário toque em Consultar/Teste inicial.
  async function connect() {
    if (!checkEnvironment() || port || busy) return;
    busy = true;
    updateControls();
    try {
      // Chrome apresenta os dispositivos SPP já pareados, inclusive o "OBD".
      const selectedPort = await navigator.serial.requestPort({
        filters: [{ bluetoothServiceClassId: SPP_UUID }]
      });
      await selectedPort.open({ baudRate: 9600, bufferSize: 4096 });
      port = selectedPort;
      closing = false;
      buffer = [];
      const info = port.getInfo ? port.getInfo() : {};
      $.selected.textContent = "Porta SPP " + (info.bluetoothServiceClassId || SPP_UUID);
      setStatus("Conectado ao canal serial (aguardando comando)", "ok");
      log("INFO", "SPP conectado. O baudRate é obrigatório na API, mas ignorado pela ponte Bluetooth.");
      readerTask = readLoop(selectedPort);
    } catch (err) {
      log("ERRO", "Conexão: " + errorText(err));
      setStatus("Não conectado", "err");
      // Caso a porta tenha sido aberta e a inicialização falhe.
      if (port) await disconnect();
    } finally {
      busy = false;
      updateControls();
    }
  }

  function rejectPending(message) {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timeout);
    buffer = [];
    current.reject(new Error(message));
  }

  // Fluxo de bytes, não pacotes RFCOMM: resposta pode estar fragmentada.
  function consume(bytes) {
    log("RX", hexOf(bytes));
    if (!pending) return;
    buffer.push(...bytes);
    if (buffer.length > 8192) {
      rejectPending("Buffer excedeu limite de segurança (8192 bytes).");
      return;
    }
    const { header, length } = pending;
    // O protocolo observado responde com eco exato dos 5 bytes enviados.
    let start = -1;
    for (let i = 0; i + header.length <= buffer.length; i++) {
      if (header.every((v, j) => buffer[i + j] === v)) { start = i; break; }
    }
    if (start < 0) {
      // Preserva 4 bytes para reconhecer eco dividido entre duas leituras.
      if (buffer.length > 4) buffer = buffer.slice(-4);
      return;
    }
    if (start > 0) {
      log("INFO", "Descartados " + start + " bytes antes do eco da consulta.");
      buffer = buffer.slice(start);
    }
    const needed = 5 + 3 + length; // eco(5) + status(1) + comprimento(1) + dados + checksum(1)
    if (buffer.length < needed) return;
    const full = buffer.slice(0, needed);
    const body = full.slice(5);
    if (body[1] !== length + 3 || !checksumValid(body)) {
      log("ERRO", "Resposta incompatível/checksum inválido: " + hexOf(full));
      buffer = buffer.slice(1);
      return;
    }
    const result = {
      command: pending.id,
      status: body[0],
      data: body.slice(2, -1),
      raw: full,
      checksum: true
    };
    const completed = pending;
    pending = null;
    clearTimeout(completed.timeout);
    buffer = [];
    responseCount++;
    $.last.textContent = "0x" + completed.id + ": " + hexOf(result.data) +
      " · status " + result.status + " · checksum OK";
    log("OK", "ID 0x" + completed.id + " · dados: " + hexOf(result.data) +
      " · status: " + result.status + " · checksum OK");
    completed.resolve(result);
  }

  async function readLoop(activePort) {
    try {
      reader = activePort.readable.getReader();
      while (!closing) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) consume(value);
      }
    } catch (err) {
      if (!closing) log("ERRO", "Leitura: " + errorText(err));
    } finally {
      if (reader) {
        try { reader.releaseLock(); } catch (_) { /* sem lock */ }
        reader = null;
      }
      if (!closing && port === activePort) {
        log("INFO", "Canal Bluetooth encerrado pelo dispositivo.");
        setStatus("Conexão interrompida", "err");
        // Não aguarda a própria readerTask.
        void disconnect(true);
      }
    }
  }

  async function sendCommand(command) {
    if (!port || !port.writable || closing || pending)
      throw new Error("Porta indisponível ou consulta já em andamento.");
    const header = Array.from(bytesOf(command.bytes));
    if (!checksumValid(header)) throw new Error("Checksum inválido no comando local.");
    buffer = [];
    const reply = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => rejectPending("Sem resposta válida em " + TIMEOUT_MS + " ms."), TIMEOUT_MS);
      pending = { id: command.id, header, length: command.length, timeout, resolve, reject };
    });
    let writer = null;
    try {
      writer = port.writable.getWriter();
      await writer.write(Uint8Array.from(header));
      txCount++;
      log("TX", command.bytes + " · consulta 0x" + command.id);
    } catch (err) {
      rejectPending("Falha ao enviar: " + errorText(err));
      throw err;
    } finally {
      if (writer) writer.releaseLock();
    }
    return reply;
  }

  async function single() {
    if (busy || !port) return;
    busy = true;
    updateControls();
    try {
      const command = commandById.get($.command.value);
      setStatus("Consultando 0x" + command.id + "…");
      const result = await sendCommand(command);
      setStatus("Conectado · resposta válida 0x" + result.command, "ok");
    } catch (err) {
      log("ERRO", errorText(err));
      if (port) setStatus("Conectado · consulta sem resposta válida", "err");
    } finally {
      busy = false;
      updateControls();
    }
  }

  async function probe() {
    if (busy || !port) return;
    busy = true;
    sequenceAbort = false;
    updateControls();
    const ids = ["78", "00", "10", "20", "3C"];
    log("INFO", "Teste inicial iniciado · 5 consultas de leitura conhecidas (sem escrita de configuração).");
    try {
      for (const id of ids) {
        if (sequenceAbort || closing || !port) break;
        const command = commandById.get(id);
        setStatus("Teste inicial · consultando 0x" + id + "…");
        try {
          await sendCommand(command);
        } catch (err) {
          log("ERRO", "ID 0x" + id + ": " + errorText(err));
        }
        if (sequenceAbort || closing || !port) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!closing && port) setStatus("Conectado · teste concluído (" + responseCount + " respostas totais)", "ok");
      log("INFO", "Teste inicial finalizado. Exporte o log para análise.");
    } finally {
      busy = false;
      updateControls();
    }
  }

  async function disconnect(fromReadLoop = false) {
    if (!port || closing) return;
    closing = true;
    sequenceAbort = true;
    updateControls();
    const oldPort = port;
    rejectPending("Conexão encerrada.");
    try {
      if (reader) {
        try { await reader.cancel(); } catch (_) { /* encerrando */ }
      }
      if (!fromReadLoop && readerTask) {
        try { await readerTask; } catch (_) { /* encerrando */ }
      }
      await oldPort.close();
    } catch (err) {
      log("ERRO", "Ao desconectar: " + errorText(err));
    } finally {
      port = null;
      readerTask = null;
      $.selected.textContent = "Nenhum scanner selecionado";
      setStatus("Desconectado");
      log("INFO", "Porta fechada.");
      closing = false;
      updateControls();
    }
  }

  function download() {
    if (!logs.length) return;
    const exportData = {
      source: "CivicLab Web Serial HonDash v1",
      captureTime: new Date().toISOString(),
      interpretation: "HEX bruto; IDs de sensores não mapeados",
      totals: { commands: txCount, validReplies: responseCount },
      events: logs
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "civiclab-hondash-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $.connect.addEventListener("click", connect);
  $.disconnect.addEventListener("click", () => void disconnect());
  $.send.addEventListener("click", single);
  $.probe.addEventListener("click", probe);
  $.download.addEventListener("click", download);
  $.clear.addEventListener("click", () => {
    logs = []; txCount = 0; responseCount = 0;
    $.log.textContent = ""; $.last.textContent = "Ainda sem resposta.";
    updateControls();
    $.count.textContent = "0"; $.responses.textContent = "0";
  });
  if ("serial" in navigator) {
    navigator.serial.addEventListener("disconnect", (event) => {
      if (event.target === port) void disconnect();
    });
  }
  checkEnvironment();
  updateControls();
  log("INFO", "Bancada iniciada. Versão experimental; os comandos não são OBD-II ELM327.");
})();