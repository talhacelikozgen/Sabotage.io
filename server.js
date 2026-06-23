const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '')));

// Odaların ve durumların tutulacağı ana hafıza
let rooms = {};

// Rastgele 4 karakterli benzersiz oda ID'si üretme
function generateRoomId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id;
    do {
        id = '';
        for (let i = 0; i < 4; i++) {
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (rooms[id]);
    return id;
}

function getDistance(a, b) {
    let matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
}

function scrambleWord(word) {
    if (word.length <= 1) return word;
    let arr = word.split('');
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.join('');
}

function temizleKarakterler(metin) {
    return metin.toLowerCase().replace(/[^a-zçğıöşü]/g, '').trim();
}

function startTimer(roomId) {
    let room = rooms[roomId];
    if (!room) return;

    clearInterval(room.timerInterval);
    room.timeLeft = room.maxTime;
    io.to(roomId).emit('timerUpdate', room.timeLeft);
    
    room.timerInterval = setInterval(() => {
        room.timeLeft--;
        if (room.timeLeft <= 0) {
            room.timeLeft = 0;
            clearInterval(room.timerInterval);
            io.to(roomId).emit('systemMessage', { text: "Süre bitti! Yeni tura geçiliyor...", type: "c-system" });
            setTimeout(() => nextTurn(roomId), 2500);
        } else {
            io.to(roomId).emit('timerUpdate', room.timeLeft);
        }
    }, 1000);
}

function nextTurn(roomId) {
    let room = rooms[roomId];
    if (!room || room.players.length === 0) return;

    room.narratorIndex = (room.narratorIndex + 1) % room.players.length;
    room.hasGuessedList = [];
    room.secretWord = "araba"; // İleride kelime havuzu veya seçmeli yapılabilir.
    
    let currentNarrator = room.players[room.narratorIndex];
    
    io.to(roomId).emit('newRound', {
        narratorId: currentNarrator.id,
        narratorName: currentNarrator.name
    });
    startTimer(roomId);
}

io.on('connection', (socket) => {
    let currentRoomId = null;

    // 1. ODA KURMA MOTORU
    socket.on('createRoom', (data) => {
        let nick = data.username.trim() || "Oyuncu_1";
        let maxPlayers = parseInt(data.maxPlayers, 10) || 4;
        let chosenMinutes = parseInt(data.duration, 10) || 3;
        
        let roomId = generateRoomId();
        
        rooms[roomId] = {
            id: roomId,
            maxPlayers: Math.min(20, Math.max(1, maxPlayers)),
            maxTime: chosenMinutes * 60,
            timeLeft: chosenMinutes * 60,
            timerInterval: null,
            players: [],
            ownerId: socket.id,
            gameStarted: false,
            secretWord: "araba",
            narratorIndex: 0,
            hasGuessedList: []
        };

        let playerObj = { id: socket.id, name: nick, score: 0, isOwner: true };
        rooms[roomId].players.push(playerObj);
        
        currentRoomId = roomId;
        socket.join(roomId);

        // Kurucuya odanın kurulduğunu ve detaylarını gönder
        socket.emit('roomJoined', { roomId: roomId, isOwner: true, players: rooms[roomId].players });
    });

    // 2. ODAYA KATILMA MOTORU
    socket.on('joinRoom', (data) => {
        let nick = data.username.trim() || "Oyuncu";
        let roomId = data.roomId.toUpperCase().trim();

        let room = rooms[roomId];
        if (!room) {
            socket.emit('lobbyError', 'Oda bulunamadı!');
            return;
        }
        if (room.gameStarted) {
            socket.emit('lobbyError', 'Bu oda zaten oyuna başlamış!');
            return;
        }
        if (room.players.length >= room.maxPlayers) {
            socket.emit('lobbyError', 'Oda dolu!');
            return;
        }

        let playerObj = { id: socket.id, name: nick, score: 0, isOwner: false };
        room.players.push(playerObj);
        
        currentRoomId = roomId;
        socket.join(roomId);

        // Katılan kişiye ekranı açtır
        socket.emit('roomJoined', { roomId: roomId, isOwner: false, players: room.players });
        // Odadaki herkese listeyi güncellettir
        io.to(roomId).emit('updateLobbyPlayers', room.players);
    });

    // 3. OYUNU BAŞLATMA (Sadece Sahip Tetikler)
    socket.on('startGame', () => {
        let room = rooms[currentRoomId];
        if (!room || room.ownerId !== socket.id || room.gameStarted) return;

        room.gameStarted = true;
        room.narratorIndex = 0;
        room.hasGuessedList = [];

        io.to(currentRoomId).emit('gameStartedSignal');
        
        let currentNarrator = room.players[room.narratorIndex];
        io.to(currentRoomId).emit('updatePlayers', room.players);
        io.to(currentRoomId).emit('newRound', { narratorId: currentNarrator.id, narratorName: currentNarrator.name });
        startTimer(currentRoomId);
    });

    // 4. İPUCU MOTORU
    socket.on('sendClue', (rawClue) => {
        let room = rooms[currentRoomId];
        if (!room || !room.gameStarted) return;

        let typedClue = temizleKarakterler(rawClue);
        let narrator = room.players[room.narratorIndex];
        if (!narrator || socket.id !== narrator.id) return;

        if (typedClue.includes(room.secretWord) || getDistance(typedClue, room.secretWord) <= 1) {
            socket.emit('systemMessage', { text: "HATA: İpucu gizli kelimeye çok yakın veya kelimeyi içeriyor!", type: "c-system" });
            return;
        }

        let finalClue = (Math.random() * 100 < 5) ? typedClue : scrambleWord(typedClue);
        if (Math.random() * 100 < 5) {
            room.timeLeft = Math.max(0, room.timeLeft - 5);
            io.to(currentRoomId).emit('systemMessage', { text: "⚠️ Sabotaj başarısız! Süreden 5 saniye kesildi.", type: "c-system" });
        }

        io.to(currentRoomId).emit('clueReceived', finalClue);
    });

    // 5. TAHMİN / SOHBET MOTORU
    socket.on('sendGuess', (rawGuess) => {
        let room = rooms[currentRoomId];
        if (!room || !room.gameStarted) return;

        let typedGuess = temizleKarakterler(rawGuess);
        let pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === -1) return;
        
        let p = room.players[pIndex];
        let narrator = room.players[room.narratorIndex];

        if (socket.id === narrator.id) {
            socket.emit('systemMessage', { text: "Anlatıcı kendisi tahmin yürütemez!", type: "c-system" });
            return;
        }

        if (room.hasGuessedList.includes(socket.id)) {
            socket.emit('systemMessage', { text: "Kelimeyi bildiğiniz için chat alanına mesaj gönderemezsiniz!", type: "c-system" });
            return;
        }

        if (typedGuess === room.secretWord) {
            room.hasGuessedList.push(socket.id);
            p.score += 1;
            
            io.to(currentRoomId).emit('updatePlayers', room.players);
            io.to(currentRoomId).emit('systemMessage', { text: `🎉 ${p.name} kelimeyi doğru tahmin etti!`, type: "c-success" });

            if (room.hasGuessedList.length === (room.players.length - 1)) {
                io.to(currentRoomId).emit('systemMessage', { text: "Herkes kelimeyi bild! Yeni tura geçiliyor...", type: "c-system" });
                clearInterval(room.timerInterval);
                setTimeout(() => nextTurn(currentRoomId), 2500);
            }
        } else if (getDistance(typedGuess, room.secretWord) === 1) {
            io.to(currentRoomId).emit('systemMessage', { text: `${p.name} gizli kelimeye çok yaklaştı!`, type: "c-close" });
        } else {
            io.to(currentRoomId).emit('chatMessage', { name: p.name, text: rawGuess });
        }
    });

    // 6. BAĞLANTI KOPMA DURUMU
    socket.on('disconnect', () => {
        if (!currentRoomId || !rooms[currentRoomId]) return;
        
        let room = rooms[currentRoomId];
        let wasOwner = (room.ownerId === socket.id);

        room.players = room.players.filter(p => p.id !== socket.id);
        
        if (room.players.length === 0) {
            clearInterval(room.timerInterval);
            delete rooms[currentRoomId];
        } else {
            // Eğer odadan çıkan sahipse, liderliği yeni birine ata
            if (wasOwner) {
                room.ownerId = room.players[0].id;
                room.players[0].isOwner = true;
                io.to(room.players[0].id).emit('makeOwner');
            }

            if (room.gameStarted) {
                io.to(currentRoomId).emit('updatePlayers', room.players);
                if (socket.id === room.players[room.narratorIndex]?.id) {
                    io.to(currentRoomId).emit('systemMessage', { text: "Anlatıcı oyundan ayrıldı, yeni tura geçiliyor...", type: "c-system" });
                    nextTurn(currentRoomId);
                }
            } else {
                io.to(currentRoomId).emit('updateLobbyPlayers', room.players);
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
