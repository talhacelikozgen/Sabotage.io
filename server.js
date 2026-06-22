const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Statik dosyaları (index.html) sunmak için
app.use(express.static(path.join(__dirname, '')));

// Global Oyun Durumu
let players = []; 
let secretWord = "araba";
let narratorIndex = 0; // Dizideki anlatıcı sırası
let hasGuessedList = [];
let timeLeft = 300;
let timerInterval = null;

// Levenshtein Mesafe Algoritması (Sunucu Tarafı Güvenliği)
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

function startTimer() {
    clearInterval(timerInterval);
    timeLeft = 300;
    io.emit('timerUpdate', timeLeft);
    
    timerInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            timeLeft = 0;
            clearInterval(timerInterval);
            io.emit('systemMessage', { text: "Süre bitti! Yeni tura geçiliyor...", type: "c-system" });
            setTimeout(nextTurn, 2500);
        } else {
            io.emit('timerUpdate', timeLeft);
        }
    }, 1000);
}

function nextTurn() {
    if (players.length === 0) return;
    narratorIndex = (narratorIndex + 1) % players.length;
    hasGuessedList = [];
    
    // Basitlik adına sunucu yeni kelimeyi otomatik "uçak" veya lobi kelimesi yapar.
    // Gelişmiş sürümde anlatıcıya seçtireceğiz.
    secretWord = "uçak"; 
    
    io.emit('newRound', {
        narratorId: players[narratorIndex].id,
        narratorName: players[narratorIndex].name
    });
    startTimer();
}

io.on('connection', (socket) => {
    console.log('Yeni bir oyuncu bağlandı: ' + socket.id);

    // Oyuncu Giriş Yaptığında
    socket.on('joinGame', (username) => {
        let cleanName = username.trim() || "Oyuncu_" + (players.length + 1);
        let newPlayer = { id: socket.id, name: cleanName, score: 0 };
        players.push(newPlayer);

        io.emit('updatePlayers', players);

        // Eğer ilk oyuncuysa onu anlatıcı yapıp oyunu başlatalım
        if (players.length === 1) {
            narratorIndex = 0;
            io.emit('newRound', { narratorId: socket.id, narratorName: cleanName });
            startTimer();
        } else {
            // Yeni gelen oyuncuya mevcut durumu bildir
            socket.emit('timerUpdate', timeLeft);
            socket.emit('syncRound', { narratorId: players[narratorIndex].id, narratorName: players[narratorIndex].name });
        }
    });

    // İpucu Gönderildiğinde
    socket.on('sendClue', (rawClue) => {
        let typedClue = temizleKarakterler(rawClue);
        if (socket.id !== players[narratorIndex].id) return;

        if (typedClue.includes(secretWord) || getDistance(typedClue, secretWord) <= 1) {
            socket.emit('systemMessage', { text: "HATA: İpucu gizli kelimeye çok yakın veya kelimeyi içeriyor!", type: "c-system" });
            return;
        }

        let finalClue = (Math.random() * 100 < 5) ? typedClue : scrambleWord(typedClue);
        if (Math.random() * 100 < 5) {
            timeLeft = Math.max(0, timeLeft - 5);
            io.emit('systemMessage', { text: "⚠️ Sabotaj başarısız! Süreden 5 saniye kesildi.", type: "c-system" });
        }

        io.emit('clueReceived', finalClue);
    });

    // Tahmin/Chat Mesajı Geldiğinde
    socket.on('sendGuess', (rawGuess) => {
        let typedGuess = temizleKarakterler(rawGuess);
        let pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex === -1) return;
        
        let p = players[pIndex];

        if (socket.id === players[narratorIndex].id) {
            socket.emit('systemMessage', { text: "Anlatıcı kendisi tahmin yürütemez!", type: "c-system" });
            return;
        }

        if (hasGuessedList.includes(socket.id)) {
            socket.emit('systemMessage', { text: "Kelimeyi bildiğiniz için chat alanına mesaj gönderemezsiniz!", type: "c-system" });
            return;
        }

        if (typedGuess === secretWord) {
            hasGuessedList.push(socket.id);
            p.score += 1;
            
            io.emit('updatePlayers', players);
            io.emit('systemMessage', { text: `🎉 ${p.name} kelimeyi doğru tahmin etti!`, type: "c-success" });

            if (hasGuessedList.length === (players.length - 1)) {
                io.emit('systemMessage', { text: "Herkes kelimeyi bild! Yeni tura geçiliyor...", type: "c-system" });
                clearInterval(timerInterval);
                setTimeout(nextTurn, 2500);
            }
        } else if (getDistance(typedGuess, secretWord) === 1) {
            io.emit('systemMessage', { text: `${p.name} gizli kelimeye çok yaklaştı!`, type: "c-close" });
        } else {
            io.emit('chatMessage', { name: p.name, text: rawGuess });
        }
    });

    // Bağlantı Koptuğunda
    socket.on('disconnect', () => {
        console.log('Oyuncu ayrıldı: ' + socket.id);
        players = players.filter(p => p.id !== socket.id);
        io.emit('updatePlayers', players);

        if (players.length === 0) {
            clearInterval(timerInterval);
        } else if (socket.id === players[narratorIndex]?.id) {
            io.emit('systemMessage', { text: "Anlatıcı oyundan ayrıldı, yeni tura geçiliyor...", type: "c-system" });
            nextTurn();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
