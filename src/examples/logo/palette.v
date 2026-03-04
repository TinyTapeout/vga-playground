/*
 * Copyright (c) 2024 Tiny Tapeout LTD
 * SPDX-License-Identifier: Apache-2.0
 * Author: Uri Shaked
 */

`default_nettype none

module palette (
    input  wire [2:0] color_index,
    output wire [5:0] rrggbb
);

  reg [5:0] palette[7:0];

  initial begin
    palette[0] = 6'b001011;  // cyan
    palette[1] = 6'b110110;  // pink
    palette[2] = 6'b101101;  // green
    palette[3] = 6'b111000;  // orange
    palette[4] = 6'b110011;  // purple
    palette[5] = 6'b011111;  // yellow
    palette[6] = 6'b110001;  // red
    palette[7] = 6'b111111;  // white
  end

  assign rrggbb = palette[color_index];

endmodule
