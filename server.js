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
const roles = ['werewolf', 'villager', "seer"];
let currentPhase = 'waiting'; // waiting, night-werewolf, day-discussion, day-vote
let phaseTimeout = null;
let werewolfVotedArray = [];
let dayVotedArray = [];
let nightKilled = '';
let dayKilled = '';
const PHASE_DURATIONS = {
    'night-seer': 20000,        // 30 secondes pour le seer
    'night-werewolf': 30000,    // 30 secondes pour les loups
    'day-discussion': 120000,   // 2 minutes de discussion
    'day-vote': 30000,          // 30 secondes pour voter
};
let currentPhaseStartTime = null;
let phaseTimeRemainingInterval = null;

// function assignRoles() {
//     return roles.sort(() => Math.random() - 0.5);
// }

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

function executeWerewolfVotes() {
    var werewolfVotedNumber = {};
    werewolfVotedArray.forEach((vote) => {
        werewolfVotedNumber[vote.votedPseudo] = (werewolfVotedNumber[vote.votedPseudo] || 0) + 1;
    });
    const result = findKeyWithMaxValue(werewolfVotedNumber);
    playersInGame.forEach((player) => {
        if (player.pseudo === result) {
            player.isAlive = false;
            nightKilled = player.pseudo;
        }
    });
    broadcast({ type: "playersInGameUpdate", players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });
    werewolfVotedArray = [];
    broadcast({ type: 'werewolfHasVoted', werewolfVotedArray: werewolfVotedArray });
    sendInfoNight();
}

function executeDayVotes() {
    var dayVotedNumber = {};
    dayVotedArray.forEach((vote) => {
        dayVotedNumber[vote.votedPseudo] = (dayVotedNumber[vote.votedPseudo] || 0) + 1;
    });
    const result = findKeyWithMaxValue(dayVotedNumber);
    playersInGame.forEach((player) => {
        if (player.pseudo === result) {
            player.isAlive = false;
            dayKilled = player.pseudo;
        }
    });
    broadcast({ type: "playersInGameUpdate", players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });
    dayVotedArray = [];
    broadcast({ type: 'dayHasVoted', dayVotedArray: dayVotedArray });
    sendInfoDay();
}

function sendInfoNight() {
    if (nightKilled !== '') {
        broadcast({ type: 'infoNight', message: `Cette nuit, ${nightKilled} a été éliminé !` });
        nightKilled = '';
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
    messages = [];
    currentPhase = 'waiting';
    currentPhaseStartTime = null;
    phaseTimeout = null;
    phaseTimeRemainingInterval = null;

    // Informer tous les clients que la partie est arrêtée.
    broadcast({ type: 'gameStopped', message: 'La partie a été arrêtée.' });
    broadcast({ type: 'playersInGameUpdate', players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });

    broadcast({type: 'resetGame'})

    console.log('La partie a été arrêtée.');
}

function startNextPhase() {
    clearTimeout(phaseTimeout);
    clearInterval(phaseTimeRemainingInterval);

    switch (currentPhase) {
        case 'waiting':
            currentPhase = 'night-seer';
            if (!playersInGame.find(player => player.role === 'seer').isAlive) {
                startNextPhase();
            }
            break;
        case 'night-seer':
            currentPhase = 'night-werewolf';
            break;
        case 'night-werewolf':
            executeWerewolfVotes();
            currentPhase = 'day-discussion';
            checkGameState();
            break;
        case 'day-discussion':
            currentPhase = 'day-vote';
            break;
        case 'day-vote':
            executeDayVotes();
            currentPhase = 'night-werewolf';
            checkGameState();
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

                if (chatType === 'general') {
                    broadcast({ type: 'general', message: msgData, sender, role: players.find(player => player.pseudo === sender)?.role });
                    messages.push({ type: 'general', message: msgData, sender, role: players.find(player => player.pseudo === sender)?.role });
                }
                return;
            }

            if (parsedMessage.type === 'joinGame') {
                const pseudo = parsedMessage.data;
                playersInGame.push(players.find(player => player.pseudo === pseudo));
                broadcast({ type: 'playersInGameUpdate', players: playersInGame.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role, isAlive: p.isAlive, isMayor: p.isMayor })) });

                if (playersInGame.length === roles.length) {
                    gameCanStart = true;
                    broadcast({ type: 'gameCanStart', message: 'La partie peut commencer !' });
                }
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
        broadcast({
            type: 'playersUpdate',
            players: players.map((p) => ({ id: p.id, pseudo: p.pseudo, role: p.role }))
        });
        console.log('Un joueur s\'est déconnecté.');
    });
});

const PORT = 3000;
// const HOST = '172.16.10.111';
// const HOST = '172.20.10.2';
// const HOST = '192.168.1.189';
server.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
    console.log(`WebSocket en écoute sur ws://localhost:${PORT}`);
});
