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

// Available colors for players
const PLAYER_COLORS = [
    '#FF5733', '#33FF57', '#3357FF', '#FF33A8', 
    '#33A8FF', '#A833FF', '#FFA833', '#33FFA8'
];

// Game state
let players = [];
let currentRound = 0;
let timer = null;
let timeLeft = 0;
let currentWord = '';
let currentDrawer = null;
let canvasState = null;
let drawingHistory = [];

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
    drawingHistory = [];
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

function assignPlayerColor() {
    // Find an unused color
    const usedColors = players.map(p => p.color);
    for (const color of PLAYER_COLORS) {
        if (!usedColors.includes(color)) {
            return color;
        }
    }
    // If all colors are used, pick a random one
    return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

function startRound() {
    if (players.length < 2) return;
    
    // Reset player drawing status and guesses
    players.forEach(player => {
        player.isDrawing = false;
        player.hasGuessedCorrect = false;
    });
    
    // Clear drawing history for new round
    drawingHistory = [];
    canvasState = null;
    
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
    // Clear any existing timer
    if (timer) {
        clearTimeout(timer);
    }
    
    // Update all clients with the current time
    io.emit('timer-update', timeLeft);
    
    // Decrement time and continue if there's time left
    if (timeLeft > 0) {
        timeLeft--;
        timer = setTimeout(updateTimer, 1000);
    } else {
        // Time's up! End the round
        endRound();
    }
}

function endRound() {
    // Clear the timer
    if (timer) {
        clearTimeout(timer);
    }
    
    // Notify all players that the round is over
    io.emit('round-end', {
        word: currentWord,
        scores: players.map(player => ({
            username: player.username,
            score: player.score
        }))
    });
    
    // Start the next round after a short delay
    setTimeout(startRound, 3000);
}

// Socket.IO events
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    
    // Join game
    socket.on('join-game', (username) => {
        console.log(`Player ${username} joined the game`);
        
        // Assign a color to the player
        const playerColor = assignPlayerColor();
        
        // Create player object
        const player = {
            id: socket.id,
            username: username,
            score: 0,
            isDrawing: false,
            hasGuessedCorrect: false,
            color: playerColor
        };
        
        // Add player to the game
        players.push(player);
        
        // Notify the player of their assigned color
        socket.emit('assignColor', playerColor);
        
        // Notify the player
        socket.emit('game-joined', {
            totalRounds: TOTAL_ROUNDS
        });
        
        // Send the current canvas state if available
        if (canvasState) {
            socket.emit('loadCanvas', canvasState);
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
        
        // Store the drawing point in history
        drawingHistory.push(data);
        
        // Broadcast to other players
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
        
        drawingHistory = [];
        canvasState = null;
        socket.broadcast.emit('clear-canvas');
    });
    
    // ... rest of the existing socket event handlers ...
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 