// server.js
import 'dotenv/config';

import express from "express";
import multer from "multer";
import http from "http";
import { Server } from "socket.io";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";

import { NodeSSH } from 'node-ssh';
import fsSync from "fs";



try {
  const dirs = ["settings", "logs"];
  dirs.forEach(dir => {
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
  });

} catch (err) {
  console.log("Directory setup failed: "+ err.message);
}

const logsDir = "./logs";
const logsRoot = path.resolve("logs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 4000;
const appName = process.env.APPNAME ; 

    
const app = express();
const server = http.createServer(app);
//const io = new Server(server);
const io = new Server(server, {
  cors: {
    origin: "*",
  }
});


  let child = null;
  let defaultEnvVariable={}
  let terminalLogs = []; // keep recent logs
  let terminalCMD = ''; // keep recent logs
  const deployConfigFile = `settings/deployConfig.json`;
  const deployOptionsFile = `settings/deployOptions.json`;
  let sshConnection; // global or outer scope
  let isConnected = false;
  let withSudo='';
    
  let logFile = ``;
  let defaultServerId='default';
  let prevCMD=``;
  let logData = {
    deployment_type:null,
    deployment_steps:null,
    page_urls:null,
    timestamp: null,
    duration_seconds: 0,
    exit_code: null,
    status: 'Running',
    warnings:null,
    errors:null,
    stdout: null,
    stderr: null,
    terminalLogs:'',
    cmd:''
  };
  let envVariable=''
  let remoteBuildPID = null;



app.use(express.static(path.join(__dirname, "public")));
app.use(cors());

// Storage location + rename file
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "settings/");
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage: storage });

// Upload single file
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  res.json({
    message: "File uploaded successfully!",
    file: req.file
  });
});

async function connectSSH(HostName,UserName,PrivateKey) {
  if (isConnected) {
    return;
  }

  sshConnection = new NodeSSH();

  try {
    await sshConnection.connect({
    host: HostName,
    username: UserName,
    privateKey: fsSync.readFileSync(
      './settings/' + PrivateKey,
      'utf8'
    ),
  });

    isConnected = true;

  } catch (err) {
    console.error("SSH connect failed:", err.message);
    isConnected = false;
  }
}



// Utility: get build stats (15 days)
function getBuildStats(defaultEnvVariable,ServerId) {
  try {
    const files = fsSync.readdirSync(logsDir).filter(f => f.startsWith(ServerId) && f.endsWith(".json"));
    const logFilesWithTime = files.map(f => {
      const stat = fsSync.statSync(path.join(logsDir, f));
      return { name: f, mtime: stat.mtimeMs };
    }).sort((a, b) => a.mtime - b.mtime); // oldest first

    const maxLogs = defaultEnvVariable.maxLogs || 5;
    if (logFilesWithTime.length > maxLogs) {
      const toRemove = logFilesWithTime.slice(0, logFilesWithTime.length - maxLogs);
      toRemove.forEach(f => {
        try { fsSync.unlinkSync(path.join(logsDir, f.name)); } catch (e) {}
      });
    }


    const logs = files
      .map(f => {
      try {
      return JSON.parse(fsSync.readFileSync(path.join(logsDir, f), "utf8"));
      } catch (e) {
      return null;
      }
      })
      .filter(Boolean)
      .filter(log => log.status!='Running')
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));



    if (logs.length === 0) {
      return { logsList:[], total: 0, successRate: 0, avgDuration: 0, currentStreak: 0 };
    }

    let total = logs.length;
    let successCount = 0;
    let totalDuration = 0;
    let currentStreak = 0;
    let streakActive = true;

    logs.forEach(log => {
      const isSuccess = log.exit_code === 0;
      if (isSuccess) {
        successCount++;
        if (streakActive) currentStreak++;
      } else {
        streakActive = false;
      }
      if (log.duration_seconds) totalDuration += parseFloat(log.duration_seconds);
    });

    const avgDuration = (totalDuration / total).toFixed(2);
    const successRate = ((successCount / total) * 100).toFixed(2);

    return { logsList:logs, currentStreak, successRate, avgDuration, total };
  } catch (err) {
    return { logsList:[],currentStreak: 0, successRate: 0, avgDuration: 0, total: 0 };
  }
}

let logDirty = false;

function addLog(line) {
  if (!line || line.length <= 1) return;

  const textLine = `<p>[${new Date().toLocaleString()}] ${line}</p>`;

  // update memory only (fast)
  logData = {
    ...logData,
    timestamp: logData.timestamp || Date.now(),
    terminalLogs: (logData.terminalLogs || "") + textLine,
    GraphqlErrors: line.includes("Graphql Error")
      ? (logData.GraphqlErrors || 0) + 1
      : (logData.GraphqlErrors || 0),
  };

  logDirty = true;

  terminalLogs.push(textLine);
  if (terminalLogs.length > 400) terminalLogs.shift();

  io.emit("terminal", {
    textLine,
    terminalCMD,
    GraphqlErrors: logData.GraphqlErrors
  });

  const keyword = "Process finished";
    
    if (logFile != '' && !textLine.includes(keyword)) {
      try{
      
      const logFileData = fsSync.readFileSync(logFile, "utf-8");
      const logFileJsonData = JSON.parse(logFileData);
      const deployOptionsFileData = fsSync.readFileSync(deployOptionsFile, "utf-8");
      const deployOptionsFilejsonData = JSON.parse(deployOptionsFileData);
      if(prevCMD!=logFileJsonData.cmd){
        prevCMD =logFileJsonData.cmd
      io.emit("restartTimer", {cmd:logFileJsonData.cmd,deployOptions:deployOptionsFilejsonData,
      GraphqlErrors: logFileData.GraphqlErrors});
      }
      }catch(e){
  
      }
    }

}
setInterval(() => {
  
  if (logDirty && logFile) {
    try {
      fsSync.writeFileSync(logFile, JSON.stringify(logData, null, 2));
      logDirty = false;
    } catch (e) {
      console.log("Disk write failed:", e.message);
    }
  }
}, 1500);
function getTimeInMinSec(estimatedTotalDeploymentTime){
        try{
            const avgDurationMinutes = Math.floor(estimatedTotalDeploymentTime / 60);
            const avgDurationSeconds = estimatedTotalDeploymentTime % 60;
            return `${avgDurationMinutes}m ${avgDurationSeconds}s`
        }catch(e){
           return `` 
        }
}

io.on("connection", (socket) => {

  // Send log history to new client
  socket.emit("terminalHistory", {terminalLogs:terminalLogs,terminalCMD:terminalCMD});
  
  if (logFile != '') {
    try{
    const logFileData = fsSync.readFileSync(logFile, "utf-8");
    const logFileJsonData = JSON.parse(logFileData);
    const deployOptionsFileData = fsSync.readFileSync(deployOptionsFile, "utf-8");
    const deployOptionsFilejsonData = JSON.parse(deployOptionsFileData);
    socket.emit("restartTimer", {timestamp:logFileJsonData.timestamp,cmd:logFileJsonData.cmd,deployOptions:deployOptionsFilejsonData});
    }catch(e){
      
    }
 }
  
  async function runMagentoCommands() {
    try {
      await connectSSH(defaultEnvVariable.magentoHost,defaultEnvVariable.magentousername,defaultEnvVariable.magentoprivateKey)
      

      
      const magentoCommands = [
          defaultEnvVariable.magentoDirPath+'/bin/magento cache:flush',
          'chmod -R 777 '+defaultEnvVariable.magentoDirPath+'/var/ '+defaultEnvVariable.magentoDirPath+'/generated/ '+defaultEnvVariable.magentoDirPath+'/pub/static',
          defaultEnvVariable.magentoDirPath+'/bin/magento indexer:reindex'
        ];

      for (const magentoCmd of magentoCommands) {

        let magentoCMDText = magentoCmd;

        if (!magentoCmd.includes("chmod -R 777")) {
          magentoCMDText = magentoCmd.includes("indexer:reindex")
            ? "Reindex Indexer"
            : "Flush Cache";

          addLog(`⚠️ Running: ${magentoCMDText}`);
        }

        socket.emit("cmdStatus", "magento_flush_cache", "boxrunning");

        const { stdout, stderr, code } = await sshConnection.execCommand(magentoCmd);

        if (stdout.trim()) addLog('✅ '+stdout.trim());
        if (stderr.trim()) addLog('❌ '+stderr.trim());

        if (code !== 0) {
          addLog(`❌ Command failed: ${magentoCMDText}, Process finished`);
          socket.emit("cmdStatus", "magento_flush_cache", "boxerror");
          logFile = ``;
          terminalCMD='';
          terminalLogs=[]
          if (child) {
            child.kill("SIGTERM");
            child = null;
          }
          return false; // ❌ STOP sequence
        }
        if (!magentoCmd.includes("chmod -R 777")) {
        addLog(`✅ Finished "${magentoCMDText}"`);
        }
        
      }
      socket.emit("cmdStatus", "magento_flush_cache", "boxcompleted");
      return true; // ✅ ALL DONE

    } catch (error) {
      
      addLog(`❌ Error: ${error.message}, Process finished`);
      socket.emit("cmdStatus", "magento_flush_cache", "boxerror");
      logFile = ``;
          terminalCMD='';
          terminalLogs=[]
          if (child) {
            child.kill("SIGTERM");
            child = null;
          }
      return false;
    } finally {
      if (isConnected && sshConnection){
          await sshConnection.dispose();
          isConnected=false
      } 
    }
  }





  async function execudeCommand(cmd,createBackup,deploymentType,start){
    
    return new Promise(async (resolve, reject) => {
    try {
      logData = {
        ...logData, 
        cmd: cmd
      };
      fsSync.writeFileSync(logFile, JSON.stringify(logData, null, 2));

      let strdeploymentType='Running: '+ cmd.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());


      if(cmd==='npm run build'){
       strdeploymentType='Deploying: '+deploymentType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      }else if(cmd=='magento flush cache'){
       strdeploymentType='Running: Flush Cache and Refresh Index'
      }else if(cmd.includes('git pull')){
        strdeploymentType='Running: Git Pull'
      }else if(cmd.includes('npm install')){
        strdeploymentType='Running: Install Dependencies'
      }else if(cmd.includes('rm -rf')){
        strdeploymentType='Running: Clear local cache'
      }

      terminalCMD=`⚠️  ${strdeploymentType}`;
      addLog(`⚠️ ${strdeploymentType}`);
      
      
      if (cmd==="magento flush cache") {
        const result =await runMagentoCommands();
          if (!result) {
            resolve(false);
            return;
          }else{
            resolve(true);
            return;
          }
        
      }else{
         try{
                        await connectSSH(defaultEnvVariable.frontHost,defaultEnvVariable.frontUsername,defaultEnvVariable.frontPrivateKey)
                        const ROOT_DIR = defaultEnvVariable.frontDirPath;
        
                        socket.emit('cmdStatus', cmd,'boxrunning');
                        let sshCMD =''
                        let wrappedCMD=''
                        
                          if (cmd.startsWith("rm -rf")) {
                              wrappedCMD = cmd.replace(/^rm\s+-rf\s+/, `${withSudo} rm -rf ${ROOT_DIR}/`);
                          } else {
                              const needsNode = cmd.startsWith("npm");
        
                              sshCMD = `
                              cd ${ROOT_DIR} || exit 1
                              ${needsNode ? `
                              export NVM_DIR="$HOME/.nvm"
                              [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
                              ` : ""}
                              ${withSudo+' '+cmd}
                              `;
                              if (cmd === "npm run build") {
                              wrappedCMD = `
                                bash -lc '
                                (
                                ${sshCMD}
                                ) &
                                PID=$!
                                echo BUILD_PID:$PID
                                wait $PID
                                '
                                `;
                              }else{
                                wrappedCMD = sshCMD
                              }
                      }
        
                        const result = await sshConnection.execCommand(wrappedCMD, {
                          onStdout(chunk) {
                            const text = chunk.toString();
                            const match = text.match(/BUILD_PID:(\d+)/);
                            if (match) {
                              remoteBuildPID = match[1];
                              return;
                            }
                            addLog(text.slice(0, 150));
                          },
                          onStderr(chunk) {
                            const text = chunk.toString().slice(0, 150);
                            addLog(text);
                          }
                        });

                        
        
                        
                        if (result.code !== 0) {
                        const end = Date.now();
                        const durationTotal = ((end - start) / 1000).toFixed(2);
                        const warnings = (result.stdout.match(/warning/gi) || []).length;
                        const errors = (result.stderr.match(/error/gi) || []).length;
        
                        const totalavgDurationSeconds = Math.floor(durationTotal);
                        addLog(`❌ Build failed, Process finished in ${getTimeInMinSec(totalavgDurationSeconds)}.`);
                        logData = {
                        ...logData, 
                        duration_seconds: durationTotal,
                        exit_code: result.code,
                        status: result.code === 0 ? "✅ SUCCESS" : "❌ FAILED",
                        warnings,
                        errors,
                        };
                        fsSync.writeFileSync(logFile, JSON.stringify(logData, null, 2));
                        socket.emit('cmdStatus', cmd,'boxerror');
                        logFile = ``;
                        terminalCMD='';
                        terminalLogs=[]
                        if (child) {
                        child.kill("SIGTERM");
                        child = null;
                        }
                        resolve(false);
                        return;
                        }else{
                        socket.emit('cmdStatus', cmd,'boxcompleted');
                        let cmdText = cmd.includes("npm run build")
                        ? `${deploymentType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())} Deployment`
                        : cmd;
                        addLog(`✅ Finished "${cmdText}"`);
                        }
        
                        if (cmd === "npm run build") {
                          let ServerDeployOptions={
                                type:'complete_application',
                                pageUrls:'',
                          }
        
                          const ServerdeployOptionsJson = Buffer.from(JSON.stringify(ServerDeployOptions)).toString("base64");
                          let serverdeployOptionsCMD = `
                          echo ${ServerdeployOptionsJson} | base64 -d > ${ROOT_DIR}/deployOptions.json
                          `;
                          await sshConnection.execCommand(serverdeployOptionsCMD);
                          
        
                        if (createBackup) {
        
                        if(logFile!=''){ 
                        try {
                        logData = {
                        ...logData, 
                        cmd: 'create_backup'
                        };
        
                        fsSync.writeFileSync(logFile, JSON.stringify(logData, null, 2));
        
                        } catch (e) {
                        console.log('Oops! '+e.message)
                        }
                        }
        
        
                        socket.emit('cmdStatus', 'create_backup','boxrunning');
                        terminalCMD=`⚠️ Generating backup...`;
                        addLog("⚠️ Generating backup...");
                        
        
                        const timestampBase = new Date().toISOString().replace(/[:.]/g, "-");
                        const MAX_BACKUPS = defaultEnvVariable.maxBackups;
        
                        const backUpcmd = `
                        cd ${ROOT_DIR} || exit 1
                        ${withSudo} mkdir -p backups

                        if [ -d build ]; then
                          sourceDir="build"
                        elif [ -d out ]; then
                          sourceDir="out"
                        elif [ -d .next ]; then
                          sourceDir=".next"
                        else
                          echo "No build or out directory found"
                          exit 1
                        fi
                        sourceDirName="\${sourceDir#.}"
                        ZIP_NAME="\${sourceDirName}-${timestampBase}.zip"

                        ${withSudo} zip -rq "\$ZIP_NAME" "\$sourceDir"
                        ${withSudo} mv "\$ZIP_NAME" backups/

                        # 🔥 Keep only latest ${MAX_BACKUPS} backups
                        cd backups || exit 1
                        ls -1t "\${sourceDirName}-"*.zip | tail -n +$(( ${MAX_BACKUPS} + 1 )) | xargs -r ${withSudo} rm -f
                        echo "\$ZIP_NAME"
                        `;

        
                        const backupResult = await sshConnection.execCommand(backUpcmd);
        
                          if(backupResult.code !== 0){
                            addLog('❌ '+backupResult.stderr.trim())
                            socket.emit('cmdStatus', 'create_backup','boxerror');
                            logData = {
                            ...logData, 
                            exit_code: backupResult.code,
                            status: "❌ FAILED",
                            };
                            fsSync.writeFileSync(logFile, JSON.stringify(logData, null, 2));
                            // resolve(false);
                            // return;
                            addLog('❌ Backup Created Failed: '+backupResult.stderr.trim())
                            socket.emit('cmdStatus', 'create_backup','boxcompleted');

                          }else{
                            addLog('✅  Backup Created: '+backupResult.stdout.trim())
                            socket.emit('cmdStatus', 'create_backup','boxcompleted');
                          }
                          
                          await sshConnection.execCommand("pm2 update");
                              
                        }else{
                          await sshConnection.execCommand("pm2 update");
                        }
                        
                        const end = Date.now();
                        const durationTotal = ((end - start) / 1000).toFixed(2);
                        const warnings = (result.stdout.match(/warning/gi) || []).length;
                        const errors = (result.stderr.match(/error/gi) || []).length;
        
                        const totalavgDurationSeconds = Math.floor(durationTotal);
                        terminalCMD=`⚠️ Saving build log...`;  
                        addLog(`⚠️ Saving build log`);
                        logData = {
                        ...logData, 
                        duration_seconds: durationTotal,
                        exit_code: result.code,
                        status: result.code === 0 ? "✅ SUCCESS" : "❌ FAILED",
                        warnings,
                        errors,
                        };
                        fsSync.writeFileSync(logFile, JSON.stringify(logData, null, 2));
                        terminalCMD=`⚠️ Almost done...`; 
                        let GraphqlErrorsText=''
                        if(logData.GraphqlErrors && logData.GraphqlErrors>0){
                        const plural = logData.GraphqlErrors === 1 ? "" : "s";
                        GraphqlErrorsText = ` with ${logData.GraphqlErrors} graphql error${plural}`;
                        }
                        addLog(`✅ Process finished ${GraphqlErrorsText} in ${getTimeInMinSec(totalavgDurationSeconds)}, View Site at <a target="_blank" href="${defaultEnvVariable.baseURL || defaultEnvVariable.BASE_URL || null}">${defaultEnvVariable.baseURL || defaultEnvVariable.BASE_URL || null}</a>`);
                        logFile = ``;
                        terminalCMD='';
                        terminalLogs=[]
                        resolve(true);
                        return;
        
        
                        }else{
                        resolve(true);
                        return;
                        }
        
              
                }catch (error) {
                addLog(`❌ Error: ${error.message}, Process finished`);
                socket.emit("cmdStatus", cmd, "boxerror");
                    logFile = ``;
                    terminalCMD='';
                    terminalLogs=[]
                    if (child) {
                      child.kill("SIGTERM");
                      child = null;
                    }
                return false;
              } finally {
                resolve(true);
                return;
              }
      
      }

    } catch (err) {
      console.log(err)
      socket.emit("BuildProcessStopped");
      logFile = ``;
      terminalCMD='';
      terminalLogs=[]
      resolve(false);
      return;
    }
    });
   
  }
  
  socket.on("stopSHH", async() => {
          await sshConnection.dispose();
          isConnected=false
          socket.emit("stopedSHH");
  })
  socket.on("stopBuildProcess", async() => {

            try {
                if (remoteBuildPID) {
                  await sshConnection.execCommand(`kill -9 ${remoteBuildPID}`);
                  remoteBuildPID = null;
                }
            } catch (e) {
              addLog(`Kill failed: ${e.message}`);
            }
    



          if (isConnected && sshConnection){
            await sshConnection.dispose();
            isConnected=false
          }
          logFile = ``;
          terminalCMD='';
          terminalLogs=[]
          
          if (child?.pid) {
            try {
              process.kill(-child.pid, "SIGTERM"); // kill group
              child = null;
            } catch (err) {
              addLog("Failed to kill process:", err.message);
            }
          }

          addLog(`✅ Build Process Stopped...`);
          socket.emit("BuildProcessStopped");
          
    
  })
  socket.on("runCommand", async (AllCommands, createBackup,deploymentType,deploymentSteps,pageUrls,start,newEnvVariable,deployOptions) => {
    
      defaultEnvVariable=newEnvVariable
      if (logFile === '') {
        logFile = `logs/${defaultServerId}-${Date.now()}.json`;
        logData = {
                deployment_type:deploymentType,
                deployment_steps:deploymentSteps,
                page_urls:pageUrls,
                duration_seconds: 0,
                exit_code: null,
                status: 'Running',
                warnings:null,
                errors:null,
                stdout: null,
                stderr: null,
                timestamp:start,
                terminalLogs:'',
                cmd: AllCommands[0],
                GraphqlErrors:0
          };
        fsSync.writeFileSync(logFile, JSON.stringify(logData, null, 2));
      }
      if(defaultEnvVariable.frontHost!='' && defaultEnvVariable.frontUsername!='' && defaultEnvVariable.frontPrivateKey!=''){
        
        await connectSSH(defaultEnvVariable.frontHost,defaultEnvVariable.frontUsername,defaultEnvVariable.frontPrivateKey)
        const ROOT_DIR = defaultEnvVariable.frontDirPath;
        try{
            let InitCmd = `
              ${withSudo} mkdir -p ${ROOT_DIR}/cacheM/category \
                      ${ROOT_DIR}/cacheM/product \
                      ${ROOT_DIR}/cacheM/static &&
              ${withSudo} touch ${ROOT_DIR}/deployOptions.json
              `;
              await sshConnection.execCommand(InitCmd);

              const deployOptionsJson = Buffer.from(JSON.stringify(deployOptions)).toString("base64");
              let deployOptionsCMD = `
              echo ${deployOptionsJson} | base64 -d > ${ROOT_DIR}/deployOptions.json
              `;
              await sshConnection.execCommand(deployOptionsCMD);
           }catch(e){
            console.log(e.message)
          }
      

    for (const cmd of AllCommands) {
        try {
            if(cmd!='create backup'){
            const result =await execudeCommand(cmd, createBackup, deploymentType, start);
              if (!result) {
                addLog(`❌ Process finished, build failed at: ${cmd}`);
                break;
              }
          }
        } catch (err) {
          addLog(`❌ Process finished, with error: ${err.message} at: ${cmd}`);
          break;
        }
    }
  }else{
    addLog(`❌ Process finished, with error: no SSH details found`);
              logData = {
                ...logData, 
                status: "❌ FAILED",
                };
                fsSync.writeFileSync(logFile, JSON.stringify(logData, null, 2));
  }

    
  });


  socket.on("resetDeploymentOptions", async(deployOptions) => {
        try {
            fsSync.writeFileSync(deployOptionsFile, JSON.stringify(deployOptions, null, 2));
            } catch (e) {
          }

  });

  socket.on("getStatics", async(getBackup=false) => {
      
      let backups=[];
      let stats={};
      let defaultServer=''
      
      let deployOptions={
        type:null,
        pageUrls:null,
        commands:null
      }

    try{
      if (fsSync.existsSync(deployConfigFile)) {
        const deployConfigFiledata = fsSync.readFileSync(deployConfigFile, "utf-8");
          if(deployConfigFiledata){
            const deployConfigData = JSON.parse(deployConfigFiledata);
            envVariable = deployConfigData
          }
      } 

      if (fsSync.existsSync(deployOptionsFile)) {
        const deployOptionsFiledata = fsSync.readFileSync(deployOptionsFile, "utf-8");
          if(deployOptionsFiledata){
            const deployOptionsData = JSON.parse(deployOptionsFiledata);
            deployOptions=deployOptionsData
          }
      } 
      
      
      defaultServer =deployOptions.selectedServer?deployOptions.selectedServer:'';
      if(defaultServer && envVariable && envVariable.servers && envVariable.servers[defaultServer]){

      }else{
        defaultServer=''
        if(envVariable && envVariable.servers){
          const serverNames = Object.keys(envVariable.servers || {});
          defaultServer =serverNames[0]
        }
      }
      
      

      if(defaultServer && envVariable && envVariable.servers && envVariable.servers[defaultServer]){
        defaultEnvVariable =envVariable.servers[defaultServer]
      } 
      if(defaultEnvVariable && defaultEnvVariable.frontHost 
        && defaultEnvVariable.frontHost!='' 
        && defaultEnvVariable.frontUsername 
        && defaultEnvVariable.frontUsername!='' 
        && defaultEnvVariable.frontPrivateKey!='' 
        && defaultEnvVariable.frontDirPath!='')
        {
            
            const SSHOk = await validateSSH(defaultEnvVariable.frontHost,defaultEnvVariable.frontUsername,defaultEnvVariable.frontPrivateKey,defaultEnvVariable.frontDirPath,defaultEnvVariable.ServerName)
            if(SSHOk){
                defaultServerId = defaultServer
                

                if(getBackup){
                  const ROOT_DIR = defaultEnvVariable.frontDirPath;
                  const listCmd = `
                    cd ${ROOT_DIR}/backups || exit 1
                    ls -lt *.zip
                    `;
                    const listResult = await sshConnection.execCommand(listCmd);
                    backups = listResult.stdout
                    .trim()
                    .split("\n")
                    .filter(Boolean)
                    
                }
               
                stats = getBuildStats(defaultEnvVariable,defaultServerId);
              
                socket.emit("returnStatics", {
                  currentStreak: stats.currentStreak?stats.currentStreak:'0',
                  successRate: stats.successRate?stats.successRate:'0',
                  avgDuration: stats.avgDuration?stats.avgDuration:'0',
                  logs:stats.logsList?stats.logsList:[],
                  envVariable:envVariable,
                  deployOptions:deployOptions,
                  backups:backups,
                  defaultServer:defaultServer
               });
            }else{
                
                socket.emit("returnStatics", {
                  currentStreak: stats.currentStreak?stats.currentStreak:'0',
                  successRate: stats.successRate?stats.successRate:'0',
                  avgDuration: stats.avgDuration?stats.avgDuration:'0',
                  envVariable:envVariable,
                  deployOptions:deployOptions,
                  backups:backups,
                  logs:[],
                  defaultServer:defaultServer
                });
              }
      }else{
        
        socket.emit("returnStatics", {
          currentStreak: 0,
          successRate: 0,
          avgDuration: 0,
          envVariable:envVariable,
          deployOptions:deployOptions,
          backups:backups,
          logs:[],
          defaultServer:defaultServer
      });
      
    }
    
    } catch (e) {
       
        socket.emit("returnStatics", {
          currentStreak: 0,
          successRate: 0,
          avgDuration: 0,
          envVariable:envVariable,
          deployOptions:deployOptions,
          backups:backups,
          logs:[],
          defaultServer:defaultServer
      });
    }

  });
  
  socket.on("deleteServer", async(serverName) => {
    if (isConnected && sshConnection){
          await sshConnection.dispose();
          isConnected=false
    }

    let config = { servers: {} };
        if (fsSync.existsSync(deployConfigFile)) {
                  config = JSON.parse(fsSync.readFileSync(deployConfigFile, "utf8"));
        
        if (!config.servers || !config.servers[serverName]) {
          return
        }
        delete config.servers[serverName];
        fsSync.writeFileSync(
                  deployConfigFile,
                  JSON.stringify(config, null, 2)
                );
        }

  })
  
  socket.on("validateEnvSettings", async(Config) => {
    let BackedSSHStatus =true
    if(Config.magentoHost || Config.magentousername  || Config.magentoprivateKey){
      BackedSSHStatus = await validateSSH(Config.magentoHost,Config.magentousername,Config.magentoprivateKey,Config.magentoDirPath,Config.ServerName,true)
    }
    const frontSSHStatus = await validateSSH(Config.frontHost,Config.frontUsername,Config.frontPrivateKey,Config.frontDirPath,Config.ServerName,true)
    socket.emit("validateEnvSettingsStatus",frontSSHStatus,BackedSSHStatus);

  })

  socket.on("saveEnvSettings", async(ServerConfig) => {
    
        try {
              const newServerConfig = ServerConfig;

              // ✅ random ID
              const randomId =newServerConfig.id?newServerConfig.id:"srv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

              let config = { servers: {} };

              if (fsSync.existsSync(deployConfigFile)) {
                const raw = fsSync.readFileSync(deployConfigFile, "utf8").trim();
                if (raw) config = JSON.parse(raw);
              }

              config.servers = config.servers || {};

              // ✅ add using random ID
              config.servers[randomId] = newServerConfig;

              fsSync.writeFileSync(
                deployConfigFile,
                JSON.stringify(config, null, 2)
              );

            } catch (e) {
              console.log(e.message);
            }

  })

  async function validateSSH(Host,Username,PrivateKey,DirPath,ServerName=null,onlyValidate=false) {
    try{
    let returnStatus
    await connectSSH(Host,Username,PrivateKey)
    const ROOT_DIR = DirPath;
    const result = await sshConnection.execCommand(`
      if [ -d "${ROOT_DIR}" ]; then
        echo "OK"
      else
        echo "MISSING"
      fi
    `);
    if(result.stdout.trim() === "OK"){
      if(!onlyValidate){
       socket.emit("shhStatus", "🟢 Connected ("+ServerName+")");
      }
      returnStatus = true;
    }else{
      if(!onlyValidate){
        socket.emit("shhStatus", "🔴 Disconnected ("+ServerName+")");
      }
      returnStatus = false;
    }
    if(onlyValidate){
          await sshConnection.dispose();
          isConnected=false
     }
    return returnStatus
  } catch (err) {
    if(!onlyValidate){
      socket.emit("shhStatus", "🔴 Disconnected ("+ServerConfig.ServerName+")");
    }else{
          await sshConnection.dispose();
          isConnected=false
     }
    return false
  }
  
  }

  

  socket.on("rollbackBuild", async (backupName, backupAction) => {
    if (!backupName) {
        socket.emit("rollbackComplete", "❌ No action defined.");
        return;
    }

    if (!backupAction) {
        socket.emit("rollbackComplete", "❌ No action defined.");
        return;
    }
  let returnMessage='';
  let backups=[];
  try{
    await connectSSH(defaultEnvVariable.frontHost,defaultEnvVariable.frontUsername,defaultEnvVariable.frontPrivateKey)
    const ROOT_DIR = defaultEnvVariable.frontDirPath;
    let rollbackCMD=''
    if (backupAction === "restore") {
        rollbackCMD = `
        cd ${ROOT_DIR} || exit 1
        BACKUP_NAME="${backupName}"
          # detect source dir from zip name
          if echo "$BACKUP_NAME" | grep -q "^build-"; then
            sourceDir="build"
          elif echo "$BACKUP_NAME" | grep -q "^out-"; then
            sourceDir="out"
          elif echo "$BACKUP_NAME" | grep -q "^.next"; then
            sourceDir=".next"
          else
            echo "Invalid backup name"
            exit 1
          fi

          # safety backup
          OLD_BACKUP_NAME="\${sourceDir}_old_\$(date +%s)"
          if [ -d "$sourceDir" ]; then
            "${withSudo}" mv "$sourceDir" "$OLD_BACKUP_NAME"
          fi

          # restore
          if unzip -q "backups/$BACKUP_NAME"; then
            # cleanup old backup ONLY after success
            if [ -d "$OLD_BACKUP_NAME" ]; then
              "${withSudo}" rm -rf "$OLD_BACKUP_NAME"
            fi
            echo "Backup Restored :- $BACKUP_NAME → $sourceDir"
          else
            echo "Restore failed, rolling back"
            if [ -d "$OLD_BACKUP_NAME" ]; then
              "${withSudo}" mv "$OLD_BACKUP_NAME" "$sourceDir"
            fi
            exit 1
          fi
          
          `;
    }else if (backupAction === "remove") {
        rollbackCMD = `
        cd ${ROOT_DIR}/backups || exit 1
        BACKUP_NAME="${backupName}"

        # safety check
        if [ ! -f "$BACKUP_NAME" ]; then
          echo "Backup not found"
          exit 1
        fi

        "${withSudo}" rm -f "$BACKUP_NAME"
        echo "Backup Removed:- $BACKUP_NAME"
        `;
    }
   
          const rollbackResult = await sshConnection.execCommand(rollbackCMD);
          if(rollbackResult.code !== 0){
            returnMessage = `❌ ${rollbackResult.stderr.trim()}`;
          }else{
            returnMessage = `✅ ${rollbackResult.stdout.trim()}`;
          }
          

          const listCmd = `
          cd ${ROOT_DIR}/backups || exit 1
          ls -lt *.zip
          `;

          const listResult = await sshConnection.execCommand(listCmd);
          backups = listResult.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          socket.emit("rollbackComplete", returnMessage,backups);

    } catch (error) {
      socket.emit("rollbackComplete", error.message);
    } finally {
      if (isConnected && sshConnection){
          await sshConnection.dispose();
          isConnected=false
      }
    }
  });

  

   

  socket.on("stopCommand", async() => {
    if (isConnected && sshConnection){
          await sshConnection.dispose();
          isConnected=false
    }
    const message = "✅ Process finished, Stopped by user.";
    if (child) {
      try {
        child.kill("SIGTERM");
        child = null;

          if(logFile!=''){
            try { fsSync.unlinkSync(logFile) } catch (e) {console.log(e)}
          }
          logFile = ``;
          terminalCMD = '';
          terminalLogs = [];
      } catch (err) {
        message = "✅ "+err.message;
      }
    }
    try {
      const res = await restartPM2();
      socket.emit("shhStatus", "🔴 Disconnected");
      socket.emit("closeLoading",appName+" server restarted: "+ res.output);
    } catch (e) {
      socket.emit("shhStatus", "🔴 Disconnected");
      socket.emit("closeLoading","PM2 restart failed: "+ e.message);
    }
    
  
  });


function restartPM2() {
  return new Promise((resolve, reject) => {
    const proc = spawn("pm2", ["restart", appName], { shell: true });

    let out = "";
    let err = "";

    proc.stdout.on("data", d => out += d.toString());
    proc.stderr.on("data", d => err += d.toString());

    proc.on("close", code => {
      if (code === 0) {
        resolve({ success: true, output: out });
      } else {
        reject(new Error(err || `PM2 exited with code ${code}`));
      }
    });
  });
}

 socket.on("changeFilePermittion", (cmd) => {
  child = spawn(cmd, { shell: true, cwd: process.cwd() });
  child.stdout.on("data", (data) => {
        const text = String(data);
      });

      child.stderr.on("data", (data) => {
        const text = String(data);
        
      });

      child.on("close", async (code) => {
        
      })
 });

  

});

server.listen(PORT, () => console.log(`${appName} running on port ${PORT}`));
