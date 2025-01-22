const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let players = [];
let playersInGame = [];
let messages = [];
let gameCanStart = false;
let roles = [];
// const roles = ['werewolf', "villager", "seer", "hunter"];
// const roles = ['werewolf', "werewolf", "werewolf", "villager", "villager", "villager", "villager", "villager", "seer"];
const roleConfigurations = {
    4: ['werewolf', 'witch', 'villager', 'villager'],
    6: ['werewolf', 'werewolf', 'villager', 'villager', 'seer', 'hunter'],
    7: ['werewolf', 'werewolf', 'villager', 'villager', 'villager', 'seer', 'hunter'],
    8: ['werewolf', 'werewolf', 'villager', 'villager', 'villager', 'villager', 'seer', 'hunter'],
    9: ['werewolf', 'werewolf', 'werewolf', 'villager', 'villager', 'villager', 'seer', 'hunter', 'littleGirl'],
    10: ['werewolf', 'werewolf', 'werewolf', 'villager', 'villager', 'villager', 'villager', 'seer', 'hunter', 'littleGirl'],
    11: ['werewolf', 'werewolf', 'werewolf', 'villager', 'villager', 'villager', 'villager', 'villager', 'seer', 'hunter', 'littleGirl'],
    12: ['werewolf', 'werewolf', 'werewolf', 'villager', 'villager', 'villager', 'villager', 'villager', 'villager', 'seer', 'hunter', 'littleGirl']
};
let currentPhase = 'waiting'; // waiting, night-werewolf, day-discussion, day-vote, night-seer, hunter-phase
let phaseTimeout = null;
let werewolfVotedArray = [];
let dayVotedArray = [];
let killedByHunter = '';
let nightKilled = '';
let dayKilled = '';
let killedByWitch = '';
let witchPotions = {
    life: false,
    death: false
};
let witchSave = false;

const PHASE_DURATIONS = {
    'night-seer': 20000,        // 30 secondes pour le seer
    'night-werewolf': 30000,    // 30 secondes pour les loups
    'night-witch': 30000,      // 30 secondes pour la sorcière
    'day-discussion': 10000,   // 2 minutes de discussion
    'day-vote': 30000,          // 30 secondes pour voter
    'hunter-phase-1': 10000,    // 10 secondes pour le hunter
    'hunter-phase-2': 10000,    // 10 secondes pour le hunter
};
let currentPhaseStartTime = null;
let phaseTimeRemainingInterval = null;

// Fonction pour assigner aléatoirement des rôles
function assignRoles() {
    // Clone l'array des rôles pour ne pas modifier l'original
    const rolesPool = [...roles];

    // Mélange l'array des rôles
    for (let i = rolesPool.length - 1; i > 0; i--) {
        const randomIndex = Math.floor(Math.random() * (i + 1));
        [rolesPool[i], rolesPool[randomIndex]] = [rolesPool[randomIndex], rolesPool[i]];
    }

    return rolesPool;
}

function broadcast(data, roleFilter = null) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            // Si un filtre de rôle est spécifié, ne pas envoyer aux autres rôles
            if (roleFilter) {
                const player = players.find(p => p.ws === client);
                if (player && player.role !== roleFilter) return;
            }
            client.send(JSON.stringify(data));
        }
    });
}

function broadcastToRole() {
    const assignedRoles = assignRoles();
    playersInGame.forEach((player, index) => {
        player.role = assignedRoles[index];
        player.ws.send(JSON.stringify({ type: 'role', role: player.role }));
    });
    broadcast({ type: 'playersInGameUpdate', players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });
}

function getWerewolfToKill(execute = false) {
    var werewolfVotedNumber = {};
    werewolfVotedArray.forEach((vote) => {
        werewolfVotedNumber[vote.votedPseudo] = (werewolfVotedNumber[vote.votedPseudo] || 0) + 1;
    });
    const result = findKeyWithMaxValue(werewolfVotedNumber);
    playersInGame.forEach((player) => {
        if (player.pseudo === result) {
            if (execute) {
                player.isAlive = false;
            } else {
                nightKilled = player.pseudo;
            }
        }
    });
}

function executeWerewolfVotes() {
    if (witchSave === false) {
        getWerewolfToKill(true);
    } else {
        witchSave = false;
    }

    broadcast({ type: "playersInGameUpdate", players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });
    werewolfVotedArray = [];
    broadcast({ type: 'werewolfHasVoted', werewolfVotedArray: werewolfVotedArray });
}

function executeWitchKillPlayer() {
    playersInGame.forEach((player) => {
        if (player.pseudo === killedByWitch) {
            player.isAlive = false;
        }
    });
    broadcast({ type: 'playersInGameUpdate', players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });
}

function executeDayVotes() {
    const dayVotedNumber = dayVotedArray.reduce((acc, vote) => {
        acc[vote.votedPseudo] = (acc[vote.votedPseudo] || 0) + 1;
        return acc;
    }, {});

    const result = findKeyWithMaxValue(dayVotedNumber);
    const playerToKill = playersInGame.find(player => player.pseudo === result);

    if (playerToKill) {
        playerToKill.isAlive = false;
        dayKilled = playerToKill.pseudo;
    }

    broadcast({ type: "playersInGameUpdate", players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });
    dayVotedArray = [];
    broadcast({ type: 'dayHasVoted', dayVotedArray: dayVotedArray });
    sendInfoDay();
}

function sendInfoNight() {
    if (nightKilled !== '' || killedByWitch !== '') {
        if (killedByWitch !== '') {
            broadcast({ type: 'infoNight', message: `Cette nuit, ${killedByWitch} a été éliminé !` });
        }
        if (nightKilled !== '') {
            broadcast({ type: 'infoNight', message: `Cette nuit, ${nightKilled} a été éliminé !` });
        }
        nightKilled = '';
        killedByWitch = '';
    } else {
        broadcast({ type: 'infoNight', message: `Cette nuit, personne n'a été éliminé !` });
    }
}

function sendInfoDay() {
    if (dayKilled !== '') {
        broadcast({ type: 'infoDay', message: `Aujourd'hui, ${dayKilled} a été éliminé !` });
        dayKilled = '';
    } else {
        broadcast({ type: 'infoDay', message: `Aujourd'hui, personne n'a été éliminé !` });
    }
}

function findKeyWithMaxValue(obj) {
    let maxVal = -Infinity;
    let maxKeys = [];

    for (const [key, value] of Object.entries(obj)) {
        if (value > maxVal) {
            maxVal = value;
            maxKeys = [key];
        } else if (value === maxVal) {
            maxKeys.push(key);
        }
    }

    // Choisir une clé au hasard en cas d'égalité
    return maxKeys[Math.floor(Math.random() * maxKeys.length)];
}

function checkGameState() {
    if (playersInGame.filter(p => p.role !== '').length === 0) {
        console.log('Les rôles ne sont pas encore distribués.');
        return;
    }

    const werewolves = playersInGame.filter(player => player.role === 'werewolf' && player.isAlive);
    const villagers = playersInGame.filter(player => player.role !== 'werewolf' && player.isAlive);

    if (werewolves.length === 0) {
        broadcast({ type: 'gameOver', message: 'Les villageois ont gagné !', winner: 'villager' });
        stopGame();

    } else if (werewolves.length >= villagers.length) {
        broadcast({ type: 'gameOver', message: 'Les loups-garous ont gagné !', winner: 'werewolf' });
        stopGame();
    }
}

function stopGame() {
    clearTimeout(phaseTimeout);
    clearInterval(phaseTimeRemainingInterval);
    currentPhaseStartTime = null;
    currentPhase = 'waiting'; // Réinitialise la phase à l'état d'attente.
    gameCanStart = false; // Réinitialise l'état de démarrage de la partie.

    // Réinitialiser les joueurs en jeu et leur état.
    playersInGame.forEach(player => {
        player.role = '';
        player.isAlive = true;
        player.isMayor = false;
    });
    playersInGame = [];

    // Réinitialiser les votes et autres états de la partie.
    werewolfVotedArray = [];
    dayVotedArray = [];
    nightKilled = '';
    dayKilled = '';
    killedByHunter = '';
    killedByWitch = '';
    witchPotions = {
        life: false,
        death: false
    };
    witchSave = false;
    messages = [];
    currentPhase = 'waiting';
    currentPhaseStartTime = null;
    phaseTimeout = null;
    phaseTimeRemainingInterval = null;

    // Informer tous les clients que la partie est arrêtée.
    broadcast({ type: 'gameStopped', message: 'La partie a été arrêtée.' });
    broadcast({ type: 'playersInGameUpdate', players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });

    broadcast({ type: 'resetGame' })

    console.log('La partie a été arrêtée.');
}

function startNextPhase() {
    clearTimeout(phaseTimeout);
    clearInterval(phaseTimeRemainingInterval);

    switch (currentPhase) {
        case 'waiting':
            currentPhase = 'night-seer';
            if (playersInGame.find(player => player.role === 'seer') === undefined || playersInGame.find(player => player.role === 'seer').isAlive === false) {
                startNextPhase();
            }
            break;
        case 'night-seer':
            currentPhase = 'night-werewolf';
            break;
        case 'night-werewolf':
            currentPhase = 'night-witch';
            if (playersInGame.find(player => player.role === 'witch') === undefined || playersInGame.find(player => player.role === 'witch').isAlive === false) {
                startNextPhase();
            }
            getWerewolfToKill();
            broadcast({ type: 'wolfWillKill', playerToDie: nightKilled });
            break;
        case 'night-witch':
            executeWerewolfVotes();
            executeWitchKillPlayer();
            sendInfoNight();
            currentPhase = 'hunter-phase-1';
            if (playersInGame.find(player => player.role === 'hunter') === undefined || playersInGame.find(player => player.role === 'hunter').isAlive === false) {
                startNextPhase();
            }
            if (killedByHunter !== '') {
                startNextPhase();
            }
            checkGameState();
            break;
        case 'hunter-phase-1':
            currentPhase = 'day-discussion';
            checkGameState();
            break;
        case 'day-discussion':
            currentPhase = 'day-vote';
            break;
        case 'day-vote':
            executeDayVotes();
            checkGameState();
            currentPhase = 'hunter-phase-2';
            if (playersInGame.find(player => player.role === 'hunter') === undefined || playersInGame.find(player => player.role === 'hunter').isAlive === false) {
                startNextPhase();
            }
            if (killedByHunter !== '') {
                startNextPhase();
            }
            break;
        case 'hunter-phase-2':
            currentPhase = 'night-seer';
            checkGameState();
            if (playersInGame.find(player => player.role === 'seer') === undefined || playersInGame.find(player => player.role === 'seer').isAlive === false) {
                startNextPhase();
            }
            break;
    }

    currentPhaseStartTime = Date.now();

    // Envoyer la mise à jour initiale de la phase
    broadcast({
        type: 'phaseChange',
        phase: currentPhase,
        timeRemaining: PHASE_DURATIONS[currentPhase]
    });

    // Mettre en place l'intervalle pour envoyer les mises à jour du temps restant
    if (PHASE_DURATIONS[currentPhase]) {
        phaseTimeRemainingInterval = setInterval(() => {
            const elapsed = Date.now() - currentPhaseStartTime;
            const remaining = PHASE_DURATIONS[currentPhase] - elapsed;

            if (remaining <= 0) {
                clearInterval(phaseTimeRemainingInterval);
            } else {
                broadcast({
                    type: 'timeUpdate',
                    timeRemaining: remaining
                });
            }
        }, 1000);

        // Programmer la prochaine phase
        phaseTimeout = setTimeout(() => {
            startNextPhase();
        }, PHASE_DURATIONS[currentPhase]);
    }
}

wss.on('connection', (ws) => {
    console.log('Un nouveau joueur s\'est connecté.');
    const id = uuidv4();

    ws.send(JSON.stringify({
        type: 'init', data: {
            messages: [...messages],
            players: [...players],
            playersInGame: playersInGame.map(p => ({
                id: p.id,
                pseudo: p.pseudo,
                role: p.role,
                isAlive: p.isAlive,
                isMayor: p.isMayor
            })),
            gameCanStart: gameCanStart,
            currentPhase: currentPhase,
            phaseTimeRemaining: PHASE_DURATIONS[currentPhase],
            werewolfVotedArray: werewolfVotedArray,
        }
    }));

    ws.on('message', (message) => {
        try {
            const parsedMessage = JSON.parse(message);

            // Gestion des messages de chat
            if (parsedMessage.type === 'message') {
                const { chatType, message: msgData, sender } = parsedMessage.data;

                const senderPlayer = players.find(player => player.pseudo === sender);

                const isNight = currentPhase === 'night-seer' || currentPhase === 'night-werewolf';

                const time = isNight ? 'night' : 'day';

                if (chatType === 'general') {
                    // broadcast({ type: 'general', message: msgData, sender, role: players.find(player => player.pseudo === sender)?.role });
                    // messages.push({ type: 'general', message: msgData, sender, role: players.find(player => player.pseudo === sender)?.role });
                    broadcast({ type: 'general', message: msgData, sender: senderPlayer, time });
                    messages.push({ type: 'general', message: msgData, sender: senderPlayer, time });
                }
                return;
            }

            if (parsedMessage.type === 'joinGame') {
                const pseudo = parsedMessage.data;
                playersInGame.push(players.find(player => player.pseudo === pseudo));
                broadcast({ type: 'playersInGameUpdate', players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });

                // if (playersInGame.length === roles.length) {
                //     gameCanStart = true;
                //     broadcast({ type: 'gameCanStart', message: 'La partie peut commencer !' });
                // }
                if (roleConfigurations[playersInGame.length]) {
                    roles = roleConfigurations[playersInGame.length];
                    gameCanStart = true;
                    broadcast({ type: 'gameCanStart', message: 'La partie peut commencer !' });
                }
            }

            if (parsedMessage.type === 'leaveGame') {
                const roleDistributed = parsedMessage.data.roleDistributed;
                const pseudo = parsedMessage.data.pseudo;
                playersInGame = playersInGame.filter(player => player.pseudo !== pseudo);
                gameCanStart = false;

                if (roleDistributed) {
                    playersInGame.forEach(player => {
                        player.role = '';
                    });
                }

                broadcast({ type: 'playersInGameUpdate', players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });

                if (!roleConfigurations[playersInGame.length]) {
                    broadcast({ type: 'gameCantStart', message: 'La partie ne peut commencer car il manque des joueurs.' });
                }
            }

            if (parsedMessage.type === 'hunterKill') {
                hunterPseudo = parsedMessage.data.hunterPseudo;
                playerPseudo = parsedMessage.data.playerPseudo;
                playersInGame.forEach((player) => {
                    if (player.pseudo === playerPseudo) {
                        player.isAlive = false;
                        killedByHunter = player.pseudo;
                    }
                });
                broadcast({ type: 'hunterHasKill', hunterPseudo: hunterPseudo, playerPseudo: playerPseudo, message: `${hunterPseudo}, le chasseur, a tué ${playerPseudo} !` });
                broadcast({ type: 'playersInGameUpdate', players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });
                checkGameState();
                startNextPhase();
            }

            if (parsedMessage.type === 'savePlayer') {
                if (parsedMessage.data.playerPseudo === nightKilled) {
                    console.log("La sorcière a sauvé un joueur !");
                    nightKilled = '';
                    playersInGame.find(player => player.pseudo === parsedMessage.data.playerPseudo).isAlive = true;
                    witchPotions.life = true;
                    witchSave = true;
                }
            }

            if (parsedMessage.type === 'witchKillPlayer') {
                playerPseudo = parsedMessage.data.playerPseudo;
                killedByWitch = playerPseudo;
            }

            if (parsedMessage.type === 'distributeRoles') {
                broadcastToRole();
            }

            if (parsedMessage.type === 'stopGame') {
                stopGame();
            }

            if (parsedMessage.type === 'startGame') {
                console.log("La partie commence !");
                currentPhase = 'waiting';
                startNextPhase();
                broadcast({ type: 'gameStarted', message: "La partie commence !" });
            }

            if (parsedMessage.type === 'voteWerewolf') {
                const { werewolfVoted } = parsedMessage.data;
                werewolfVotedArray = werewolfVoted;
                broadcast({ type: 'werewolfHasVoted', werewolfVotedArray: werewolfVotedArray });
            }

            if (parsedMessage.type === 'voteDay') {
                const { dayVoted } = parsedMessage.data;
                dayVotedArray = dayVoted;
                broadcast({ type: 'dayHasVoted', dayVotedArray: dayVotedArray });
            }

            if (parsedMessage.type === 'setPseudo') {
                const pseudo = parsedMessage.data;

                if (players.some((p) => p.pseudo === pseudo)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Pseudo déjà utilisé. Choisissez un autre pseudo.' }));
                    return;
                }

                const player = { id: id, pseudo, role: '', ws, isAlive: true, isMayor: false };
                players.push(player);

                ws.send(JSON.stringify({ type: 'welcome', message: `Bienvenue, ${pseudo}` }));

                broadcast({
                    type: 'playersUpdate',
                    players: players.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role }))
                });
            }
        } catch (error) {
            console.error('Erreur de parsing :', error);
        }
    });

    ws.on('close', () => {
        players = players.filter((p) => p.ws !== ws);
        playersInGame = playersInGame.filter((p) => p.ws !== ws);
        broadcast({
            type: 'playersUpdate',
            players: players.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role }))
        });
        broadcast({ type: 'playersInGameUpdate', players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });
        checkGameState();
        console.log('Un joueur s\'est déconnecté.');
    });
});

const PORT = 3000;
// const HOST = '172.16.10.111';
// const HOST = '172.20.10.2';
const HOST = '192.168.1.189';
// const HOST = '192.168.1.31';
// const HOST = '172.16.10.97';
server.listen(PORT, HOST, () => {
    console.log(`Serveur démarré sur http://${HOST}:${PORT}`);
    console.log(`WebSocket en écoute sur ws://${HOST}:${PORT}`);
});