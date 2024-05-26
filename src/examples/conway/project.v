/*
 * Copyright (c) 2024 Ciro Cattuto
 * based on the VGA examples by Uri Shaked
 * and on tt07-conway-term (https://github.com/ccattuto/tt07-conway-term)
 * SPDX-License-Identifier: Apache-2.0
 */

`default_nettype none

module tt_um_vga_example(
  input  wire [7:0] ui_in,    // Dedicated inputs
  output wire [7:0] uo_out,   // Dedicated outputs
  input  wire [7:0] uio_in,   // IOs: Input path
  output wire [7:0] uio_out,  // IOs: Output path
  output wire [7:0] uio_oe,   // IOs: Enable path (active high: 0=input, 1=output)
  input  wire       ena,      // always 1 when the design is powered, so you can ignore it
  input  wire       clk,      // clock
  input  wire       rst_n     // reset_n - low to reset
);

// VGA signals
wire hsync;
wire vsync;
wire [1:0] R;
wire [1:0] G;
wire [1:0] B;
wire video_active;
wire [9:0] pix_x;
wire [9:0] pix_y;

// stops/starts simulation
wire running;
assign running = ~ui_in[0];

// randomizes board state
wire randomize;
assign randomize = ui_in[1];

// TinyVGA PMOD
assign uo_out = {hsync, B[0], G[0], R[0], vsync, B[1], G[1], R[1]};

// Unused outputs assigned to 0.
assign uio_out = 0;
assign uio_oe  = 0;

// Suppress unused signals warning
wire _unused_ok = &{ena, ui_in, uio_in};

hvsync_generator hvsync_gen(
  .clk(clk),
  .reset(~rst_n),
  .hsync(hsync),
  .vsync(vsync),
  .display_on(video_active),
  .hpos(pix_x),
  .vpos(pix_y)
);

// high when the pixel belongs to the simulation rectangle
wire frame_active;
assign frame_active = (pix_x >= 64 && pix_x < 640-64 && pix_y >= 112 && pix_y < 480-112) ? 1 : 0;

// look up into the 8x8 icon bitmap for live cells
wire icon_pixel;
assign icon_pixel = icon[pix_y[2:0]][pix_x[2:0]];

// compute index into board state
wire [10:0] cell_index;
assign cell_index = (pix_y[7:3] << 6) | pix_x[8:3];

// generate RGB signals
assign R = (video_active & frame_active) ? {board_state[cell_index] & icon_pixel, 1'b1} : 2'b00;
assign G = (video_active & frame_active) ? {board_state[cell_index] & icon_pixel, 1'b1} : 2'b00;
assign B = 2'b01;
  
// clock
localparam CLOCK_FREQ = 24000000;

// reset
wire boot_reset;
assign boot_reset = ~rst_n;


// ----------------- SIMULATION PARAMS -------------------------

localparam logWIDTH = 6, logHEIGHT = 5;         // 64x32 board
localparam UPDATE_INTERVAL = CLOCK_FREQ / 10;   // 5 Hz simulation update

localparam WIDTH = 2 ** logWIDTH;
localparam HEIGHT = 2 ** logHEIGHT;
localparam BOARD_SIZE = WIDTH * HEIGHT;

reg board_state [0:BOARD_SIZE-1];         // current state of the simulation
reg board_state_next [0:BOARD_SIZE-1];    // next state of the simulation


// ----------------- SIMULATION CONTROL LOGIC --------------------

localparam ACTION_IDLE = 0, ACTION_UPDATE = 1, ACTION_COPY = 2, ACTION_INIT = 3;
reg [2:0] action;
reg action_init_complete, action_update_complete, action_copy_complete;

reg [31:0] timer;

always @(posedge clk) begin
  if (boot_reset) begin
    action <= ACTION_INIT;
    timer <= 0;
  end else begin
    case (action)
      // idle loop 
      ACTION_IDLE: begin
        if (running) begin // timer-based update trigger
          if (timer < UPDATE_INTERVAL) begin
            timer <= timer + 1;
          end else if (vsync) begin
            timer <= 0;
            action <= (~randomize) ? ACTION_UPDATE : ACTION_INIT;
          end
        end
      end

      // COPY -> (-> IDLE)
      ACTION_COPY: begin
        if (action_copy_complete)
          action <= ACTION_IDLE;
      end

      // UPDATE -> COPY (-> IDLE)
      ACTION_UPDATE: begin
        if (action_update_complete)
          action <= ACTION_COPY;
      end

      // RND -> IDLE
      ACTION_INIT: begin
        if (action_init_complete)
          action <= ACTION_IDLE;
      end

      default: begin
        action <= ACTION_IDLE;
      end
    endcase
  end
end


// ----------------- ACTION: RANDOMIZE SIMULATION STATE --------------------

reg [logWIDTH+logHEIGHT-1:0] index2;

always @(posedge clk) begin
  if (boot_reset) begin
    action_init_complete <= 0;
    index2 <= 0;
  end else if (action == ACTION_INIT && !action_init_complete) begin
    board_state[index2] <= rng;
    if (index2 < BOARD_SIZE - 1) begin
      index2 <= index2 + 1;
    end else  begin
      index2 <= 0;
      action_init_complete <= 1;
    end
  end else begin
    action_init_complete <= 0;
  end
end


// ----------------- ACTION: COMPUTE SIMULATION'S NEXT STATE --------------------

reg [logWIDTH+logHEIGHT-1:0] index3;    // index of cell being updated
wire [logWIDTH-1:0] cell_x;             // x-coordinate (column) of cell being updated
wire [logHEIGHT-1:0] cell_y;            // y coordinate (row) of cell being updated
assign cell_x = index3[logWIDTH-1:0];
assign cell_y = index3[logWIDTH+logHEIGHT-1:logWIDTH];

reg [3:0] neigh_index;                  // index of neighboring cell (0 to 7)
reg [3:0] num_neighbors;                // number of neighbors of current cell

localparam HEIGHT_MASK = {logHEIGHT{1'b1}};
localparam WIDTH_MASK = {logWIDTH{1'b1}};

always @(posedge clk) begin
  if (boot_reset) begin
    action_update_complete <= 0;
    index3 <= 0;
    neigh_index <= 0;
    num_neighbors <= 0;
  end else if (action == ACTION_UPDATE && !action_update_complete) begin
    // loop over the 8 neighbors of the current cell
    case (neigh_index)
      0: begin // (-1, +1)
        num_neighbors <= num_neighbors + board_state[((cell_y + 1) & HEIGHT_MASK) << logWIDTH | ((cell_x - 1) & WIDTH_MASK)];
        neigh_index <= neigh_index + 1;
      end

      1: begin // (0, +1)
        num_neighbors <= num_neighbors + board_state[((cell_y + 1) & HEIGHT_MASK) << logWIDTH | ((cell_x + 0) & WIDTH_MASK)];
        neigh_index <= neigh_index + 1; 
      end

      2: begin // (+1, +1)
        num_neighbors <= num_neighbors + board_state[((cell_y + 1) & HEIGHT_MASK) << logWIDTH | ((cell_x + 1) & WIDTH_MASK)];
        neigh_index <= neigh_index + 1;
      end

      3: begin // (-1, 0)
        num_neighbors <= num_neighbors + board_state[((cell_y + 0) & HEIGHT_MASK) << logWIDTH | ((cell_x - 1) & WIDTH_MASK)];
        neigh_index <= neigh_index + 1;
      end

      4: begin // (+1, 0)
        num_neighbors <= num_neighbors + board_state[((cell_y + 0) & HEIGHT_MASK) << logWIDTH | ((cell_x + 1) & WIDTH_MASK)];
        neigh_index <= neigh_index + 1;
      end

      5: begin // (-1, -1)
        num_neighbors <= num_neighbors + board_state[((cell_y - 1) & HEIGHT_MASK) << logWIDTH | ((cell_x - 1) & WIDTH_MASK)];
        neigh_index <= neigh_index + 1;
      end

      6: begin // (0, -1)
        num_neighbors <= num_neighbors + board_state[((cell_y - 1) & HEIGHT_MASK) << logWIDTH | ((cell_x + 0) & WIDTH_MASK)];
        neigh_index <= neigh_index + 1;
      end

      7: begin // (+1, -1)
        num_neighbors <= num_neighbors + board_state[((cell_y - 1) & HEIGHT_MASK) << logWIDTH | ((cell_x + 1) & WIDTH_MASK)];
        neigh_index <= neigh_index + 1;
      end

      // this state (neigh_index = 8) is used to compute the new state of the current cell
      // according to the rules of Conway's Game of Life
      8: begin
        board_state_next[index3] <= (board_state[index3] && (num_neighbors == 2)) | (num_neighbors == 3);

        neigh_index <= 0;
        num_neighbors <= 0;

        // advance to next cell to be updated, or terminate
        if (index3 < BOARD_SIZE - 1) begin
          index3 <= index3 + 1;
        end else begin
          index3 <= 0;
          action_update_complete <= 1;
        end
      end

      default: begin
        neigh_index <= 0;
      end
    endcase
  end else begin
    action_update_complete <= 0;
  end 
end


// --------------- ACTION: COPY NEW SIMULATION STATE OVER OLD ONE --------------------

reg [logWIDTH+logHEIGHT-1:0] index4;

always @(posedge clk) begin
  if (boot_reset) begin
    action_copy_complete <= 0;
    index4 <= 0;
  end else if (action == ACTION_COPY && !action_copy_complete) begin
    board_state[index4] <= board_state_next[index4];
    if (index4 < BOARD_SIZE - 1) begin
      index4 <= index4 + 1;
    end else begin
      index4 <= 0;
      action_copy_complete <= 1;
    end
  end else begin
    action_copy_complete <= 0;
  end
end


// --------------- RNG --------------------

reg [15:0] lfsr_reg; // Internal LFSR register
wire feedback;
wire rng;

// XOR the feedback taps; positions are 16, 14, 13, and 11
assign feedback = lfsr_reg[15] ^ lfsr_reg[13] ^ lfsr_reg[12] ^ lfsr_reg[10];
assign rng = lfsr_reg[0]; // Output the LSB of the LFSR

always @(posedge clk) begin
  if (boot_reset) begin
    // Set to a non-zero seed value when reset
    lfsr_reg <= 16'b0001; // Non-zero seed
  end else begin
    // Shift left by one, then bring in the new feedback bit
    lfsr_reg <= {lfsr_reg[14:0], feedback};
  end
end

// --------------- ICON FOR LIVE CELL --------------------

reg [7:0] icon[0:7];
initial begin
  icon[0] = 8'b00000000;
  icon[1] = 8'b00111100;
  icon[2] = 8'b01111110;
  icon[3] = 8'b01111110;
  icon[4] = 8'b01111110;
  icon[5] = 8'b01111110;
  icon[6] = 8'b00111100;
  icon[7] = 8'b00000000;
end

endmodule
