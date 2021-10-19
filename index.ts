import { PDFExtract, PDFExtractOptions } from "pdf.js-extract";

const dotenv = require("dotenv");
dotenv.config();
var nodemailer = require("nodemailer");
const fs = require("fs");
const pdfExtract = new PDFExtract();
const { promisify } = require("util");
const readFile = promisify(fs.readFile);
const csv = require("csvtojson");
const md5File = require("md5-file");
const readline = require("readline");
const CNPJ_FIOCOM = "48.263.115/0001-03";
const CSV_FILE = "./clientes-teste.csv";
const HASHES_FILE = "./hashes.txt";
const PASTA_BOLETOS = "./Boletos/";
const PASTA_ENVIADOS = "./Enviados/";
const HASHES_FILE_MAX_LINES = 300;
const LOG_FILE_MAX_LINES = 5000;

const envios: Envio[] = [];
let itensEnviados = [];
let itensNaoEnviados = [];
let jaEnviados = [];
let clientesNaoCadastrados = [];
let arquivosSemIdDoCliente = [];

class Envio {
  arquivoNome: string;
  arquivoHash: string;
  cliente: Cliente = new Cliente();
  notaFiscal: string;
}

class Cliente {
  nome: string;
  id: string;
  emails: string[];
}

async function readCSV(csvFile) {
  let clientes: Cliente[] = [];
  try {
    const json = await csv({ delimiter: "," }).fromFile(csvFile);
    json.forEach((row: Cliente) => {
      clientes.push(row);
    });
  } catch (error) {
    log("Erro de leitura do arquivo CSV - " + error.message);
    error.message = "Erro na leitura do arquivo CSV";
    throw error;
  }
  return clientes;
}

async function getDataFromPDF(file) {
  let id;
  let notaFiscal = "0";
  const idRegex =
    /([0-9]{2}[\.][0-9]{3}[\.][0-9]{3}[\/][0-9]{4}[\-][0-9]{2})|([0-9]{3}[\.][0-9]{3}[\.][0-9]{3}[\-][0-9]{2})/;

  try {
    log(`Extraindo dados do arquivo ${file}`);
    const data = await pdfExtract.extract(file);
    const page = data.pages[0].content;

    log(JSON.stringify(page));

    page.forEach((item) => {
      if (idRegex.test(item.str)) {
        if (!item.str.match(CNPJ_FIOCOM)) id = item.str;
      }
      if (notaFiscal == "0000") {
        // Possiveis valores: 12345, 12345/1, 12345/2, etc
        if (item.str.indexOf("/") > 0)
          item.str = item.str.substring(0, item.str.indexOf("/"));
        // Confirma que o valor encontrado eh um numero
        if (!isNaN(item.str as any)) notaFiscal = item.str;
      }

      // Setar 0000 significa que o proximo item sera o numero da NF
      if (item.str.includes("Núm. do documento")) notaFiscal = "0000";
    });
  } catch (error) {
    log("Erro ao ler os dados do arquivo " + file + " - " + error.message);
    error.message = "Erro na leitura do arquivo " + file;
    throw error;
  }
  return [id, notaFiscal];
}

function getClienteById(clientes: Cliente[], id: string) {
  log(`Obtendo cliente pelo ID = ${id}`);
  let cliente: Cliente;
  clientes.every((item) => {
    if (item.id === id) {
      cliente = item;
      return false;
    }
    return true;
  });
  return cliente;
}

async function arquivoJaEnviado(hashesFile: string, hash: string) {
  let match = false;
  const readline = require("readline");

  try {
    const fileStream = fs.createReadStream(hashesFile);
    const rl = readline.createInterface({
      input: fileStream,
    });
    log("Verificando hashes ja enviados");
    for await (const line of rl) {
      if (line === hash) {
        match = true;
      }
    }
    rl.close();
  } catch (error) {
    log("Erro na verificacao de hashes - " + error.message);
    error.message = "Erro na verificação de hashes.";
    throw error;
  }

  return match;
}

async function sendEmail(envio: Envio) {
  var transporter = nodemailer.createTransport({
    host: process.env.HOST,
    port: process.env.PORT,
    secure: process.env.SECURE,
    auth: {
      user: process.env.AUTH_USER,
      pass: process.env.AUTH_PASSWORD,
    },
  });

  let sent = false;
  try {
    var mailOptions = {
      name: process.env.NAME,
      from: process.env.FROM,
      to: envio.cliente.emails,
      //bcc: process.env.FROM,
      subject: `${process.env.SUBJECT} - ${envio.cliente.nome} - NF: ${envio.notaFiscal}`,
      html: await readFile(process.env.HTML_FILE, "utf8"),
      dsn: {
        id: envio.arquivoHash,
        return: "headers",
        notify: ["success", "failure"],
        recipient: process.env.FROM,
      },
      headers: {
        "Return-Receipt-To": `${process.env.FROM}`,
        "Disposition-Notification-To": `${process.env.FROM}`,
      },
      attachments: [
        {
          filename: envio.arquivoNome,
          path: `${PASTA_BOLETOS}${envio.arquivoNome}`,
        },
      ],
    };

    log(`----> Tentando enviar: ${JSON.stringify(envio)}`);
    const resposta = await transporter.sendMail(mailOptions);
    sent = true;
    log("Resposta do envio: " + JSON.stringify(resposta));
    log(`E-mail enviado! Adicionando a 'itensEnviados'`);
    itensEnviados.push(envio);
    log("Movendo para pasta 'Enviados'");
    const oldPath = `${PASTA_BOLETOS}${envio.arquivoNome}`;

    let today = new Date();
    let date = today.toLocaleDateString('pt-BR')
    date = date.substring(6, 10) + '-' + date.substring(3, 5) + '-' + date.substring(0, 2);

    const newPathFolder = `${PASTA_ENVIADOS}${date}`;
    if (!fs.existsSync(newPathFolder)) {
      fs.mkdirSync(newPathFolder, {
        recursive: true
      });
    }
    const newPath = `${newPathFolder}/${envio.arquivoNome}`;

    log(`Escrevendo o hash ${envio.arquivoHash} em 'hashes.txt'`);
    await fs.promises.appendFile(HASHES_FILE, envio.arquivoHash + "\n");
    await fs.promises.rename(oldPath, newPath);
  } catch (error) {
    log("Erro ao tentar enviar e-mail - " + error.message);
    if(error.message.contains("ECONNREFUSED")) sleep(5000);
    if (!sent) {
      log("E-mail nao enviado. Adicionando a 'itensNaoEnviados'");
      itensNaoEnviados.push(envio);
      erroEnviarEmail(envio, error);
    } else {
      log("Informando erro após enviar com sucesso: " + JSON.stringify(envio));
      console.log("Erro após o envio do e-mail");
      console.log("Arquivo: " + envio.arquivoNome);
      console.log("Motivo: " + error.message);
      console.log();
    }
    throw error;
  }
}

function erroEnviarEmail(envio: Envio, error: Error) {
  console.log("Erro: Não foi possível enviar o seguinte e-mail:");
  console.log("Arquivo: " + envio.arquivoNome);
  console.log("Email(s): " + envio.cliente.emails);
  console.log("Motivo: " + error.message);
  console.log();
}

async function log(text: string) {
  try {
    const timestamp = new Date();
    const info = `[${timestamp.toString().substring(0, 24)}]: ${text}`;
    await fs.promises.appendFile("log.txt", info + "\n");
  } catch (error) {
    error.message = "Erro ao escrever no log: " + error.message;
    throw error;
  }
}

async function reduzLinhasArquivo(file_path, max_linhas) {
  try {
    let entries = await fs.promises.readFile(file_path, "utf8");
    entries = entries.split("\n");
    if (entries.length > max_linhas) {
      const result = entries.slice(entries.length - (max_linhas + 1));
      await fs.promises.writeFile(file_path, result.join("\n"));
    }
  } catch (error) {
    log(
      "Erro ao reduzir linhas do arquivo: " + file_path + " - " + error.message
    );
    error.message = "Erro ao reduzir linhas do arquivo: " + file_path;
    throw error;
  }
}

function undefinedsRemoved(array) {
  var filtered = array.filter(Boolean);
  return filtered;
}

function sleep(milliseconds) {
  const date = Date.now();
  let currentDate = null;
  do {
    currentDate = Date.now();
  } while (currentDate - date < milliseconds);
}

(async function () {
  try {
    log("**** INICIANDO ****");

    log(`Reduzindo arquivo de log para ${LOG_FILE_MAX_LINES} linhas`);
    reduzLinhasArquivo("./log.txt", LOG_FILE_MAX_LINES);

    log(`Reduzindo a tabela hash para ${HASHES_FILE_MAX_LINES} linhas`);
    reduzLinhasArquivo(HASHES_FILE, HASHES_FILE_MAX_LINES);

    log("Obtendo cadastro dos clientes pelo arquivo CSV");
    const cadastroClientes: Cliente[] = await readCSV(CSV_FILE);

    log("Obtendo a relacao dos arquivos da pasta Boletos");
    var files = await fs.readdirSync(PASTA_BOLETOS);

    log(
      "Fazendo a leitura de cada PDF e criando um novo 'Envio' com os dados do cliente"
    );
    for (const file of files) {
      let envio: Envio = new Envio();
      envio.arquivoNome = file;
      envio.arquivoHash = md5File.sync(`${PASTA_BOLETOS}${file}`);

      // Obtem o CPF/CNPJ e NotaFiscal contidos no PDF
      const [clientId, notaFiscal] = await getDataFromPDF(
        `${PASTA_BOLETOS}${file}`
      );
      envio.cliente.id = clientId;
      envio.notaFiscal = notaFiscal;
      if (!envio.cliente.id) {
        log(`O arquivo ${file} não contém CPF/CNPJ`);
        arquivosSemIdDoCliente.push(envio);
      } else {
        // Obtem demais dados do cliente pelo CPF/CNPJ
        log(`Obtendo cliente pelo ID ${envio.cliente.id}`);
        const cliente: Cliente = await getClienteById(
          cadastroClientes,
          envio.cliente.id
        );

        if (!cliente) {
          log(
            "Adicionando a 'clientesNaoEncontrados': " + JSON.stringify(envio)
          );
          clientesNaoCadastrados.push(envio);
        } else {
          log(`Obteve o cliente ${JSON.stringify(envio.cliente)}`);
          log("Adicionando a 'envios': " + JSON.stringify(envio));
          envio.cliente = cliente;

          // Verifica se o arquivo ja foi enviado
          log(`Verificando se ja existe o hash ${envio.arquivoHash}`);
          if (await arquivoJaEnviado(HASHES_FILE, envio.arquivoHash)) {
            log(
              `hash ${envio.arquivoHash} encontrado (adicionando a 'jaEnviados')`
            );
            jaEnviados.push(envio);
          } else {
            // caso nao tenha sido enviado, adiciona a 'envios'
            log(`hash ${envio.arquivoHash} nao encontrado`);
            envios.push(envio);
          }
        }
      }
    }

    // Confirmacao para reenvio de arquivos já enviados
    if (jaEnviados.length != 0) {
      log("Pedindo confirmacao de e-mails 'jaEnviado(s)'");
      const confirmacaoRegex = /^NT$|^S$|^N$/i;
      console.log();
      console.log(
        `Houve tentativa para enviar ${jaEnviados.length} e-mail(s) já enviados.`
      );
      console.log("Responda: S(im) N(ão) ou NT(não p/ todos os próximos)");
      console.log();
      let continua = true;
      for (const envio of jaEnviados) {
        let resposta = "";
        while (!confirmacaoRegex.test(resposta) && continua) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          console.log(`Reenviar "${envio.arquivoNome} ?`);
          process.stdout.write("> ");
          for await (const resp of rl) {
            resposta = resp;
            if (resposta.toLowerCase() === "s") {
              log(`Sim: adicionando a 'envios': ${JSON.stringify(envio)}`);
              envios.push(envio);
              console.log(`${envio.arquivoNome} adicionado para ser reenviado`);
              jaEnviados[jaEnviados.indexOf(envio)] = undefined;
            } else if (resposta.toLowerCase() === "n") {
              log(`Nao: ${JSON.stringify(envio)}`);
              console.log(`${envio.arquivoNome} não será reenviado`);
            } else if (resposta.toLowerCase() === "nt") {
              log("Nao p/ todos os próximos");
              continua = false;
            } else {
              console.log(
                "A resposta deve ser S (sim), N (não) ou NT (não p/ todos os próximos)"
              );
            }
            console.log();
            rl.close();
          }
        }
      }
    }

    // ROTINA PARA ENVIO DOS E-MAILS
    if (envios.length == 0) {
      console.log();
      log(
        "Nada a ser enviado - verifique se há arquivos na pasta " +
          PASTA_BOLETOS
      );
      console.log(
        "Nada a ser enviado - verifique se há arquivos na pasta " +
          PASTA_BOLETOS
      );
    } else {
      log(
        "Inicio da rotina para envio dos e-mails. Total a ser enviado: " +
          envios.length
      );
      console.log();
      console.log(`Total: ${envios.length} e-mails a serem enviados:`);

      log("Iteracao de 'envios'");
      for (const envio of envios) {
        log("Iterando novo 'envio'");
        try {
          process.stdout.write(`\nEnviando ${envio.arquivoNome}... `);
          await sendEmail(envio);
          process.stdout.write(`OK`);
        } catch (error) {
          log(`Erro: ${error.message}`);
        }
      }
      console.log();

      jaEnviados = undefinedsRemoved(jaEnviados);

      log("Escrevendo o report");
      log("itensEnviados: " + itensEnviados.length);
      log("itensNaoEnviados: " + itensNaoEnviados.length);
      log("jaEnviados: " + jaEnviados.length);
      log("enviosSemClienteCadastrado: " + clientesNaoCadastrados.length);
      log("arquivosSemIdDoCliente: " + arquivosSemIdDoCliente.length);

      if (itensEnviados.length != 0) {
        console.log();
        log(`E-MAIL(S) ENVIADO(S) COM SUCESSO: ${itensEnviados.length}`);
        console.log(
          `E-MAIL(S) ENVIADO(S) COM SUCESSO: ${itensEnviados.length}`
        );
        itensEnviados.forEach((item) => {
          console.log("OK - " + item.arquivoNome);
        });
      }
      if (
        itensNaoEnviados.length != 0 ||
        jaEnviados.length != 0 ||
        arquivosSemIdDoCliente.length != 0 ||
        clientesNaoCadastrados.length != 0
      ) {
        console.log();
        const totalNaoEnviados =
          itensNaoEnviados.length +
          jaEnviados.length +
          arquivosSemIdDoCliente.length +
          clientesNaoCadastrados.length;
        log("E-MAIL(S) NÃO ENVIADO(S): " + totalNaoEnviados);
        console.log(`E-MAIL(S) NÃO ENVIADO(S): ${totalNaoEnviados}`);
        itensNaoEnviados.forEach((envio: Envio) => {
          console.log("X - " + envio.arquivoNome);
        });
        jaEnviados.forEach(async (envio) => {
          log("X - " + envio.arquivoNome + " (motivo: já enviado)");
          console.log("X - " + envio.arquivoNome + " (motivo: já enviado)");
        });
        clientesNaoCadastrados.forEach(async (envio) => {
          log(
            `X - ${envio.arquivoNome} (motivo: cliente ${envio.cliente.id} não cadastrado)`
          );
          console.log(
            `X - ${envio.arquivoNome} (motivo: cliente ${envio.cliente.id} não cadastrado)`
          );
        });
        arquivosSemIdDoCliente.forEach(async (envio) => {
          log("X - " + envio.arquivoNome + " (motivo: arquivo sem CPF/CNPJ)");
          console.log(
            "X - " + envio.arquivoNome + " (motivo: arquivo sem CPF/CNPJ)"
          );
        });
      }
    }
  } catch (error) {
    console.log();
    log("Erro:" + error.message);
    console.log("Erro na execução do programa");
    console.log("Motivo: " + error.message);
    console.log();
  }

  await log("**** FINALIZANDO ****");
  console.log();
  console.log("Finalizando...");
  console.log();
  process.exit();
})();
