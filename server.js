const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game constants
const ROUND_TIME = 80; // seconds
const TOTAL_ROUNDS = 3;
const WORDS = [
    'apple', 'banana', 'car', 'dog', 'elephant', 'fish',
    'guitar', 'house', 'igloo', 'jacket', 'kite', 'lamp',
    'mountain', 'notebook', 'orange', 'pizza', 'queen',
    'rainbow', 'snake', 'tree', 'umbrella', 'volcano',
    'watermelon', 'xylophone', 'yacht', 'zebra', 'airplane',
    'beach', 'castle', 'dinosaur', 'earth', 'fire', 'giraffe'
];

// Game state
let players = [];
let currentRound = 0;
let timer = null;
let timeLeft = 0;
let currentWord = '';
let currentDrawer = null;
let canvasState = null;

// Helper functions
function resetGame() {
    players.forEach(player => {
        player.score = 0;
        player.isDrawing = false;
        player.hasGuessedCorrect = false;
    });
    currentRound = 0;
    clearTimeout(timer);
    timeLeft = 0;
    currentWord = '';
    currentDrawer = null;
    canvasState = null;
}

function selectRandomWord() {
    const randomIndex = Math.floor(Math.random() * WORDS.length);
    return WORDS[randomIndex];
}

function getNextDrawer() {
    if (players.length < 2) return null;
    
    // Find the current drawer's index
    const currentIndex = players.findIndex(player => player.id === (currentDrawer ? currentDrawer.id : null));
    
    // Select the next player
    const nextIndex = (currentIndex + 1) % players.length;
    return players[nextIndex];
}

function startRound() {
    if (players.length < 2) return;
    
    // Reset player drawing status and guesses
    players.forEach(player => {
        player.isDrawing = false;
        player.hasGuessedCorrect = false;
    });
    
    // Select the next drawer
    currentDrawer = getNextDrawer();
    if (!currentDrawer) return;
    
    currentDrawer.isDrawing = true;
    
    // Select a random word
    currentWord = selectRandomWord();
    
    // Increment the round if we've gone through all players
    if (players.indexOf(currentDrawer) === 0) {
        currentRound++;
    }
    
    // Check if game is over
    if (currentRound > TOTAL_ROUNDS) {
        endGame();
        return;
    }
    
    // Set the timer
    timeLeft = ROUND_TIME;
    
    // Notify players
    players.forEach(player => {
        io.to(player.id).emit('turn-start', {
            round: currentRound,
            isDrawing: player.id === currentDrawer.id,
            drawerName: currentDrawer.username,
            word: player.id === currentDrawer.id ? currentWord : '',
            wordLength: currentWord.length
        });
    });
    
    // Update player list for everyone
    io.emit('players-update', players.map(player => ({
        username: player.username,
        score: player.score,
        isDrawing: player.isDrawing
    })));
    
    // Start the timer
    updateTimer();
}

function updateTimer() {
    io.emit('timer-update', timeLeft);
    
    if (timeLeft <= 0) {
        // Reveal the word to everyone when time is up
        io.emit('word-reveal', currentWord);
        
        // Wait 3 seconds before starting the next round
        setTimeout(startRound, 3000);
        return;
    }
    
    // Check if all players have guessed correctly
    const nonDrawingPlayers = players.filter(player => !player.isDrawing);
    const allGuessedCorrect = nonDrawingPlayers.length > 0 && 
                              nonDrawingPlayers.every(player => player.hasGuessedCorrect);
    
    if (allGuessedCorrect) {
        // Everyone guessed correctly, end the round early
        io.emit('chat-message', 'Everyone guessed correctly! Starting next round...');
        
        // Reveal the word
        io.emit('word-reveal', currentWord);
        
        // Wait 3 seconds before starting the next round
        setTimeout(startRound, 3000);
        return;
    }
    
    timeLeft--;
    timer = setTimeout(updateTimer, 1000);
}

function endGame() {
    clearTimeout(timer);
    
    // Sort players by score
    const results = [...players].sort((a, b) => b.score - a.score);
    
    // Notify players
    io.emit('game-over', results.map(player => ({
        username: player.username,
        score: player.score
    })));
    
    // Reset the game after 10 seconds
    setTimeout(() => {
        resetGame();
        if (players.length >= 2) {
            startRound();
        }
    }, 10000);
}

function checkGuess(player, message) {
    if (!currentWord || player.isDrawing || player.hasGuessedCorrect) {
        return false;
    }
    
    const guess = message.toLowerCase().trim();
    const word = currentWord.toLowerCase();
    
    if (guess === word) {
        // Calculate score based on time left
        const scoreGain = Math.ceil(timeLeft / 2) + 10;
        player.score += scoreGain;
        player.hasGuessedCorrect = true;
        
        // Give points to the drawer
        if (currentDrawer) {
            currentDrawer.score += 5;
        }
        
        return true;
    }
    
    return false;
}

// Socket.IO events
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    
    // Join game
    socket.on('join-game', (username) => {
        console.log(`Player ${username} joined the game`);
        
        // Create player object
        const player = {
            id: socket.id,
            username: username,
            score: 0,
            isDrawing: false,
            hasGuessedCorrect: false
        };
        
        // Add player to the game
        players.push(player);
        
        // Notify the player
        socket.emit('game-joined', {
            totalRounds: TOTAL_ROUNDS
        });
        
        // Send the current canvas state if available
        if (canvasState) {
            socket.emit('canvas-state', canvasState);
        }
        
        // Update player list for everyone
        io.emit('players-update', players.map(player => ({
            username: player.username,
            score: player.score,
            isDrawing: player.isDrawing
        })));
        
        // Broadcast message
        io.emit('chat-message', `${username} has joined the game`);
        
        // Start the game if we have 2+ players and game isn't running
        if (players.length >= 2 && currentRound === 0) {
            startRound();
        } else if (currentRound > 0) {
            // Game is in progress, send current game state
            socket.emit('turn-start', {
                round: currentRound,
                isDrawing: false,
                drawerName: currentDrawer ? currentDrawer.username : '',
                wordLength: currentWord.length
            });
            socket.emit('timer-update', timeLeft);
        }
    });
    
    // Drawing events
    socket.on('draw', (data) => {
        const player = players.find(p => p.id === socket.id);
        if (!player || !player.isDrawing) return;
        
        socket.broadcast.emit('draw', data);
    });
    
    socket.on('draw-end', (dataUrl) => {
        const player = players.find(p => p.id === socket.id);
        if (!player || !player.isDrawing) return;
        
        canvasState = dataUrl;
        socket.broadcast.emit('draw-end');
    });
    
    socket.on('clear-canvas', () => {
        const player = players.find(p => p.id === socket.id);
        if (!player || !player.isDrawing) return;
        
        canvasState = null;
        socket.broadcast.emit('clear-canvas');
    });
    
    // Chat messages
    socket.on('chat-message', (message) => {
        const player = players.find(p => p.id === socket.id);
        if (!player) return;
        
        // Check if the message is a correct guess
        if (checkGuess(player, message)) {
            // Notify everyone of the correct guess
            io.emit('correct-guess', `${player.username} guessed the word!`);
            
            // Update player list
            io.emit('players-update', players.map(player => ({
                username: player.username,
                score: player.score,
                isDrawing: player.isDrawing
            })));
        } else {
            // Send regular chat message
            // Don't broadcast the actual message if it contains the word
            const containsWord = currentWord && 
                                message.toLowerCase().includes(currentWord.toLowerCase());
            
            if (player.isDrawing && containsWord) {
                socket.emit('chat-message', `You can't give away the word!`);
            } else {
                io.emit('chat-message', `${player.username}: ${message}`);
            }
        }
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        const playerIndex = players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1) return;
        
        const player = players[playerIndex];
        
        // Remove the player
        players.splice(playerIndex, 1);
        
        // Broadcast message
        io.emit('chat-message', `${player.username} has left the game`);
        
        // Update player list
        io.emit('players-update', players.map(player => ({
            username: player.username,
            score: player.score,
            isDrawing: player.isDrawing
        })));
        
        // Check if the disconnected player was the drawer
        if (player.isDrawing) {
            // End the current round and start a new one
            clearTimeout(timer);
            io.emit('chat-message', `${player.username} (the drawer) has left. Starting new round...`);
            io.emit('word-reveal', currentWord);
            
            // Wait 3 seconds before starting the next round
            setTimeout(() => {
                if (players.length >= 2) {
                    startRound();
                } else {
                    resetGame();
                }
            }, 3000);
        } else if (players.length < 2) {
            // Not enough players to continue
            resetGame();
            io.emit('chat-message', 'Not enough players to continue. Waiting for more players...');
        }
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});